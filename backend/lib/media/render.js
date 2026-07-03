// lib/media/render.js — Agent-imageGen / Agent-videogen (Phase 4).
//
// Job kinds (all through the concurrency-capped queue + billing breaker):
//   render_phantom  — appearance_prompt → Nano Banana → ref face → R2 → phantoms.ref_image_key
//   render_post     — brief.post_prompt + phantom ref → Nano Banana (4:5) → R2 → piece ready
//   render_reel     — kicks the shot chain for a reel's frame_prompts (≤3):
//                       keyframe (Nano Banana, phantom ref) → Seedance (image→video) → shot → R2
//   fal_poll        — the ONLY execution path for async Fal results. Submits enqueue a
//                     poll with a `next` continuation; /webhook/fal merely ACCELERATES the
//                     queued poll (run_after=0) — no webhook/poller race, no double-ingest.
//
// SHOT LIBRARY + REUSE (the operator's "reuse these shots in multiple reels"):
//   shots land in media_assets kind='shot' meta {campaign_id, slot, source_piece_id}.
//   The FIRST reel of a campaign renders all its frames; subsequent reels render only
//   their hero frame (slot 0) and lean on campaign siblings for the rest at edit time
//   (Phase 5). SHOT_REUSE=0 disables. For a 3-reel campaign: 5 gens instead of 9.
//
// SPEND SAFETY (v1 lesson: a dashboard click billed real money immediately):
//   nothing here auto-fires after script-gen unless MEDIA_AUTOGEN=1. The console
//   shows estimateForIntake() BEFORE the operator clicks Generate.
//
// MOCK_MEDIA_GEN=1 exercises the full chain (submit → poll → continuation → R2 →
// status flips) with placeholder bytes — $0, no network.

import { intakes, phantoms, campaigns, pieces, mediaAssets, costEvents, events, jobs as jobStore } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import * as jobs from '../jobs.js';
import fal from '../fal.js';
import { loadScrapeDoc } from '../scriptgen/scrape-loader.js';

const SHOT_REUSE = () => process.env.SHOT_REUSE !== '0';
const VIDEO_SECONDS = () => parseInt(process.env.FAL_VIDEO_DURATION || '6', 10);
const VIDEO_RESOLUTION = () => process.env.FAL_VIDEO_RESOLUTION || '720p';
// USD estimates for preflight display + the cost ledger — env-tunable, not billing-grade.
// Defaults from fal.ai pages 2026-07-03: nano-banana-pro $0.15/image (1K/2K; 4K doubles),
// seedance-2.0 i2v $0.3034/sec @720p ($0.682 @1080p).
const PRICE_IMAGE = () => parseFloat(process.env.FAL_PRICE_IMAGE_USD || '0.15');
const PRICE_VIDEO_SEC = () => parseFloat(process.env.FAL_PRICE_VIDEO_SEC_USD || '0.3034');

const MOCK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MOCK_MP4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=', 'base64'); // stub bytes — pipeline plumbing only

function firstMediaUrl(result) {
  return result?.images?.[0]?.url || result?.image?.url || result?.video?.url
    || result?.output?.url || result?.url || null;
}

// Ingest a completed Fal result (or mock bytes) into R2 + media_assets.
async function ingestResult({ result, slug, kind, ext, contentType, refKind, refId, meta }) {
  const key = storage.makeKey(slug, kind, ext);
  if (result?.mock) {
    const buf = ext === 'mp4' ? MOCK_MP4 : MOCK_PNG;
    await storage.put(slug, key, buf, contentType);
    const id = mediaAssets.record({ tenantSlug: slug, kind, r2Key: key, contentType, sizeBytes: buf.length, refKind, refId, meta: { ...meta, mock: true } });
    return { key, assetId: id, mock: true };
  }
  const url = firstMediaUrl(result);
  if (!url) throw new Error(`fal result has no media URL (keys: ${Object.keys(result || {}).join(',')})`);
  const ing = await storage.ingestFromUrl(slug, key, url, { contentTypeHint: contentType });
  const id = mediaAssets.record({ tenantSlug: slug, kind, r2Key: key, contentType: ing.contentType, sizeBytes: ing.size, sha256: ing.sha256, refKind, refId, meta });
  return { key, assetId: id };
}

function recordSpend({ slug, operation, refId, images = 0, videoSeconds = 0, mock = false }) {
  const usd = mock ? 0 : images * PRICE_IMAGE() + videoSeconds * PRICE_VIDEO_SEC();
  try {
    costEvents.record({
      tenantSlug: slug, provider: 'fal', operation, refId,
      unitCount: images || videoSeconds, usd,
      meta: { estimate: true, images, video_seconds: videoSeconds, mock },
    });
  } catch { /* ledger is best-effort */ }
}

// Submit to Fal + enqueue the poll that carries the continuation.
async function submitWithPoll({ slug, modelKey, input, next, maxAttempts = 12 }) {
  const webhookBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const sub = await fal.submit(modelKey, input, {
    webhookUrl: webhookBase ? `${webhookBase}/webhook/fal` : null,
  });
  jobs.enqueue({
    kind: 'fal_poll', tenantSlug: slug, refKind: 'fal_request', refId: sub.request_id,
    payload: { requestId: sub.request_id, modelKey, next },
    maxAttempts,
  });
  return sub.request_id;
}

// ── continuations (executed by the fal_poll handler on COMPLETED) ────────────
const CONTINUATIONS = {
  // phantom face done → save ref → phantom ready
  async ingest_phantom({ result, ctx }) {
    const ph = phantoms.byId(ctx.phantomId);
    if (!ph) throw new Error(`phantom ${ctx.phantomId} gone`);
    if (ph.status === 'ready' && ph.ref_image_key) return { already: true };
    const { key } = await ingestResult({
      result, slug: ph.tenant_slug, kind: 'phantom', ext: 'png', contentType: 'image/png',
      refKind: 'phantom', refId: ph.id, meta: { phantom_id: ph.id },
    });
    phantoms.setStatus(ph.id, 'ready', key);
    recordSpend({ slug: ph.tenant_slug, operation: 'phantom.face', refId: ph.id, images: 1, mock: !!result?.mock });
    events.record({ tenantSlug: ph.tenant_slug, name: 'media.phantom_ready', props: { phantomId: ph.id } });
    return { key };
  },

  // post image done → piece ready
  async ingest_post({ result, ctx }) {
    const piece = pieces.byId(ctx.pieceId);
    if (!piece) throw new Error(`piece ${ctx.pieceId} gone`);
    if (piece.status === 'ready') return { already: true };
    await ingestResult({
      result, slug: piece.tenant_slug, kind: 'post', ext: 'png', contentType: 'image/png',
      refKind: 'piece', refId: piece.id, meta: { piece_id: piece.id, stage: 'base_image' },
    });
    pieces.setStatus(piece.id, 'ready');
    recordSpend({ slug: piece.tenant_slug, operation: 'post.image', refId: piece.id, images: 1, mock: !!result?.mock });
    events.record({ tenantSlug: piece.tenant_slug, name: 'media.post_ready', props: { pieceId: piece.id } });
    // Phase 5 auto-chain: base image done → archetype composite
    jobs.enqueue({ kind: 'compose_post', tenantSlug: piece.tenant_slug, refKind: 'piece', refId: piece.id, payload: { pieceId: piece.id }, maxAttempts: 3 });
    return { ok: true };
  },

  // keyframe image done → submit Seedance image→video for that slot
  async keyframe_to_video({ result, ctx }) {
    const piece = pieces.byId(ctx.pieceId);
    if (!piece) throw new Error(`piece ${ctx.pieceId} gone`);
    const { key } = await ingestResult({
      result, slug: piece.tenant_slug, kind: 'scratch', ext: 'png', contentType: 'image/png',
      refKind: 'piece', refId: piece.id, meta: { piece_id: piece.id, slot: ctx.slot, stage: 'keyframe' },
    });
    recordSpend({ slug: piece.tenant_slug, operation: 'reel.keyframe', refId: piece.id, images: 1, mock: !!result?.mock });
    const keyframeUrl = result?.mock ? 'mock://keyframe' : await storage.signedGet(piece.tenant_slug, key, 3600);
    const brief = JSON.parse(piece.brief);
    await submitWithPoll({
      slug: piece.tenant_slug,
      modelKey: 'video',
      input: {
        prompt: `${brief.video_description || 'natural handheld UGC motion'}. Vertical 9:16.`,
        image_url: keyframeUrl,
        duration: String(VIDEO_SECONDS()), // seedance schema: string enum "4".."15", not int
        aspect_ratio: '9:16',
        resolution: VIDEO_RESOLUTION(),
        generate_audio: false, // audio comes from the operator music library at edit time
      },
      next: { action: 'ingest_shot', ctx },
    });
    return { chained: 'video' };
  },

  // seedance shot done → shot library; last fresh shot flips the reel ready
  async ingest_shot({ result, ctx }) {
    const piece = pieces.byId(ctx.pieceId);
    if (!piece) throw new Error(`piece ${ctx.pieceId} gone`);
    await ingestResult({
      result, slug: piece.tenant_slug, kind: 'shot', ext: 'mp4', contentType: 'video/mp4',
      refKind: 'campaign', refId: piece.campaign_id,
      meta: { campaign_id: piece.campaign_id, slot: ctx.slot, source_piece_id: piece.id },
    });
    recordSpend({ slug: piece.tenant_slug, operation: 'reel.shot', refId: piece.id, videoSeconds: VIDEO_SECONDS(), mock: !!result?.mock });
    const fresh = mediaAssets.byRef('campaign', piece.campaign_id)
      .filter((a) => a.kind === 'shot' && JSON.parse(a.meta || '{}').source_piece_id === piece.id);
    if (fresh.length >= ctx.freshCount && piece.status !== 'ready') {
      pieces.setStatus(piece.id, 'ready');
      events.record({ tenantSlug: piece.tenant_slug, name: 'media.reel_ready', props: { pieceId: piece.id, freshShots: fresh.length, reused: ctx.reusedSlots } });
      // Phase 5 auto-chain: shots done → beat-cut assembly (kind-string enqueue, no import cycle)
      jobs.enqueue({ kind: 'assemble_reel', tenantSlug: piece.tenant_slug, refKind: 'piece', refId: piece.id, payload: { pieceId: piece.id }, maxAttempts: 3 });
    }
    return { shots: fresh.length, of: ctx.freshCount };
  },
};

// ── job handlers ──────────────────────────────────────────────────────────────
async function handleFalPoll({ requestId, modelKey, next }) {
  const st = await fal.status(modelKey, requestId);
  const state = st?.status || st?.state;
  if (state !== 'COMPLETED') {
    if (state === 'FAILED' || state === 'ERROR') throw new Error(`fal request ${requestId} failed: ${JSON.stringify(st).slice(0, 200)}`);
    const err = new Error(`fal ${requestId} still ${state || 'processing'}`);
    err.retryable = true;
    throw err; // → queue backoff; webhook arrival accelerates the retry to "now"
  }
  const result = await fal.result(modelKey, requestId);
  const cont = CONTINUATIONS[next.action];
  if (!cont) throw new Error(`unknown continuation '${next.action}'`);
  return await cont({ result, ctx: next.ctx });
}

async function handleRenderPhantom({ phantomId, feedback = null }) {
  const ph = phantoms.byId(phantomId);
  if (!ph) throw new Error(`phantom ${phantomId} not found`);
  if (ph.status === 'ready' && ph.ref_image_key) return { already: true };
  phantoms.setStatus(ph.id, 'rendering');
  // v1-proven ref spec: neutral studio look so every downstream gen keys off the same base.
  // QC recast feedback rides as an AVOID note — the locked appearance itself never mutates.
  const prompt = `${ph.appearance_prompt}. Studio reference portrait: plain white background, plain black t-shirt, neutral expression, front-facing, shoulders-up, soft even lighting. Photorealistic AI-generated person (not a real individual).${feedback ? ` AVOID (operator feedback from the previous take): ${feedback}` : ''}`;
  await submitWithPoll({
    slug: ph.tenant_slug, modelKey: 'image',
    input: { prompt, num_images: 1, aspect_ratio: '1:1' },
    next: { action: 'ingest_phantom', ctx: { phantomId: ph.id } },
  });
  return { submitted: true };
}

async function phantomRefUrl(piece) {
  const ph = piece.phantom_id ? phantoms.byId(piece.phantom_id) : null;
  if (!ph) return { ph: null, url: null };
  if (!ph.ref_image_key || ph.status !== 'ready') {
    const err = new Error(`phantom ${ph.id} (${ph.name}) ref not ready yet`);
    err.retryable = true;
    err.retryAfterSec = 5; // dependency wait, not a failure — retry fast
    throw err;
  }
  if (process.env.MOCK_MEDIA_GEN === '1') return { ph, url: 'mock://phantom-ref' };
  return { ph, url: await storage.signedGet(ph.tenant_slug, ph.ref_image_key, 3600) };
}

async function handleRenderPost({ pieceId }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (piece.status === 'ready') return { already: true };
  const brief = JSON.parse(piece.brief);
  const { ph, url } = await phantomRefUrl(piece);
  pieces.setStatus(piece.id, 'rendering');
  await submitWithPoll({
    // phantom ref → /edit endpoint (image_urls is required there, rejected on plain t2i)
    slug: piece.tenant_slug, modelKey: url ? 'imageEdit' : 'image',
    input: {
      prompt: `${brief.post_prompt}${ph ? `. Featuring ${ph.name}: ${ph.appearance_prompt}` : ''}. AI-generated synthetic creator.${brief.regen_feedback ? ` OPERATOR FEEDBACK (must address): ${brief.regen_feedback}` : ''}`,
      ...(url ? { image_urls: [url] } : {}),
      num_images: 1, aspect_ratio: '4:5',
    },
    next: { action: 'ingest_post', ctx: { pieceId: piece.id } },
  });
  return { submitted: true };
}

async function handleRenderReel({ pieceId }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (piece.status === 'ready') return { already: true };
  const brief = JSON.parse(piece.brief);
  const frames = (brief.frame_prompts || []).slice(0, 3);
  if (!frames.length) throw new Error(`reel ${pieceId} has no frame_prompts`);
  const { ph, url } = await phantomRefUrl(piece);

  // shot-reuse decision — ORDER-based, not pool-based: concurrent reel jobs all
  // see an empty pool at kick time (TOCTOU), so ownership comes from the pieces
  // table instead. The campaign's FIRST reel (lowest id) renders every frame;
  // siblings render only their hero (slot 0) and lean on the pool at edit time.
  const campaignReels = pieces.byIntake(piece.intake_id)
    .filter((p) => p.campaign_id === piece.campaign_id && p.kind === 'reel')
    .sort((a, b) => a.id - b.id);
  const isFirstReel = campaignReels[0]?.id === piece.id;
  const slots = frames.map((_, i) => i).filter((i) => i === 0 || !SHOT_REUSE() || isFirstReel);
  const reusedSlots = frames.length - slots.length;

  pieces.setStatus(piece.id, 'rendering');
  for (const slot of slots) {
    await submitWithPoll({
      slug: piece.tenant_slug, modelKey: url ? 'imageEdit' : 'image',
      input: {
        prompt: `${frames[slot]}${ph ? `. Featuring ${ph.name}: ${ph.appearance_prompt}` : ''}. Vertical 9:16 video keyframe. AI-generated synthetic creator.${brief.regen_feedback ? ` OPERATOR FEEDBACK (must address): ${brief.regen_feedback}` : ''}`,
        ...(url ? { image_urls: [url] } : {}),
        num_images: 1, aspect_ratio: '9:16',
      },
      next: { action: 'keyframe_to_video', ctx: { pieceId: piece.id, slot, freshCount: slots.length, reusedSlots } },
    });
  }
  logEvent({
    event: 'media.reel_kicked', tenantSlug: piece.tenant_slug, refId: piece.id,
    message: `${slots.length} fresh shot(s), ${reusedSlots} reused from campaign pool`,
  });
  return { fresh: slots.length, reused: reusedSlots };
}

// ── batch kick + estimate (console) ──────────────────────────────────────────
export function generateMedia({ intakeId, doPhantoms = true, reels = 'all', posts = 'all' }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const slug = intake.tenant_slug;
  const out = { phantoms: 0, reels: 0, posts: 0 };

  if (doPhantoms) {
    for (const ph of phantoms.byTenant(slug).filter((p) => p.intake_id === intakeId && p.status !== 'ready')) {
      jobs.enqueue({ kind: 'render_phantom', tenantSlug: slug, refKind: 'phantom', refId: ph.id, payload: { phantomId: ph.id }, maxAttempts: 3 });
      out.phantoms++;
    }
  }
  const all = pieces.byIntake(intakeId);
  const pick = (kind, want) => {
    const cand = all.filter((p) => p.kind === kind && ['briefed', 'failed'].includes(p.status));
    return want === 'all' ? cand : cand.slice(0, Math.max(0, parseInt(want, 10) || 0));
  };
  for (const p of pick('reel', reels)) {
    jobs.enqueue({ kind: 'render_reel', tenantSlug: slug, refKind: 'piece', refId: p.id, payload: { pieceId: p.id }, maxAttempts: 6 });
    out.reels++;
  }
  for (const p of pick('post', posts)) {
    jobs.enqueue({ kind: 'render_post', tenantSlug: slug, refKind: 'piece', refId: p.id, payload: { pieceId: p.id }, maxAttempts: 6 });
    out.posts++;
  }
  events.record({ tenantSlug: slug, name: 'media.batch_kicked', props: { intakeId, ...out } });
  logEvent({ event: 'media.batch_kicked', tenantSlug: slug, refId: intakeId, message: JSON.stringify(out) });
  return out;
}

export function estimateForIntake(intakeId) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const slug = intake.tenant_slug;
  const pendingPhantoms = phantoms.byTenant(slug).filter((p) => p.intake_id === intakeId && p.status !== 'ready').length;
  const all = pieces.byIntake(intakeId);
  const briefedPosts = all.filter((p) => p.kind === 'post' && p.status === 'briefed').length;
  const briefedReels = all.filter((p) => p.kind === 'reel' && p.status === 'briefed');

  // fresh-shot math mirrors handleRenderReel's ORDER-based reuse rule:
  // first reel per campaign renders all frames, siblings render slot 0 only.
  const allReelsByCampaign = new Map();
  for (const p of all.filter((x) => x.kind === 'reel')) {
    if (!allReelsByCampaign.has(p.campaign_id)) allReelsByCampaign.set(p.campaign_id, []);
    allReelsByCampaign.get(p.campaign_id).push(p.id);
  }
  for (const ids of allReelsByCampaign.values()) ids.sort((a, b) => a - b);
  let freshShots = 0; let reusedShots = 0;
  for (const p of briefedReels) {
    const frames = (JSON.parse(p.brief).frame_prompts || []).slice(0, 3);
    const isFirst = allReelsByCampaign.get(p.campaign_id)?.[0] === p.id;
    frames.forEach((_, i) => {
      if (i === 0 || !SHOT_REUSE() || isFirst) freshShots++;
      else reusedShots++;
    });
  }
  const images = pendingPhantoms + briefedPosts + freshShots; // keyframe per fresh shot
  const videoSeconds = freshShots * VIDEO_SECONDS();
  return {
    phantoms: pendingPhantoms, reels: briefedReels.length, posts: briefedPosts,
    images, video_shots: freshShots, reused_shots: reusedShots, video_seconds: videoSeconds,
    est_usd: Math.round((images * PRICE_IMAGE() + videoSeconds * PRICE_VIDEO_SEC()) * 100) / 100,
    mock_mode: process.env.MOCK_MEDIA_GEN === '1',
    prices: { image_usd: PRICE_IMAGE(), video_sec_usd: PRICE_VIDEO_SEC(), video_seconds_per_shot: VIDEO_SECONDS() },
  };
}

// Webhook accelerator — the poll job stays the single execution path.
export function onFalWebhook(requestId) {
  return jobStore.accelerateByRef('fal_poll', requestId);
}

export function registerMediaJobs() {
  jobs.register('fal_poll', handleFalPoll, { concurrency: 8 });
  jobs.register('render_phantom', handleRenderPhantom, { concurrency: 3 });
  jobs.register('render_reel', handleRenderReel, { concurrency: 2 });
  jobs.register('render_post', handleRenderPost, { concurrency: 3 });
}
