// lib/scriptgen/index.js — Agent-ScriptGen (Phase 3). Paid intake → production state.
//
// Pipeline (one `script_gen` job, restart-safe):
//   1. counts from plan (or sandbox overrides — operator picks reels/posts per brand)
//   2. CAST 6 phantoms from the scraped target-market personas   (1 synthesis call)
//   3. IDEATE campaigns against real moments (lib/moments.js)     (1 synthesis call)
//   4. ALLOCATE pieces + deployment calendar — deterministic code, no tokens:
//      largest-remainder splits so Premium = exactly 1 reel + 1 post per day,
//      pillar split over posts (40/25/20/15), all 6 phantoms round-robin
//   5. BRIEF each campaign's pieces                                (1 extraction call per campaign)
//   6. atomically insert pieces; scriptgen.json artifact → R2
//
// Budget: SCRIPTGEN_LLM_CALL_BUDGET (default 40) hard-caps total calls.
// Idempotency: proceeding always wipes this intake's phantoms/campaigns/pieces
// first; piece insertion is one transaction at the very end — a mid-run crash
// retries into a clean rebuild, never a half-calendar.

import { intakes, tenants, phantoms, campaigns, pieces, events, deployments } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import { llm } from '../llm.js';
import * as jobs from '../jobs.js';
import { tierConfig, PILLAR_SPLIT } from '../tiers.js';
import { activeMoments } from '../moments.js';
import { PHANTOM_FACE_CONSTRAINT } from '../safety.js';
import { loadScrapeDoc } from './scrape-loader.js';
import { brandLearningsBlock } from '../qc-learnings.js';

const BUDGET = () => parseInt(process.env.SCRIPTGEN_LLM_CALL_BUDGET || '40', 10);
const CAL_DAYS = () => parseInt(process.env.SCRIPTGEN_CALENDAR_DAYS || '30', 10);
const PHANTOM_COUNT = 6;

// largest-remainder split: total → n buckets, difference ≤ 1
function lrSplit(total, n) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function pillarList(postCount) {
  const entries = Object.entries(PILLAR_SPLIT);
  const counts = entries.map(([, frac]) => Math.floor(postCount * frac));
  let assigned = counts.reduce((a, b) => a + b, 0);
  const remainders = entries.map(([, frac], i) => ({ i, r: postCount * frac - counts[i] })).sort((a, b) => b.r - a.r);
  for (let k = 0; assigned < postCount; k++, assigned++) counts[remainders[k % entries.length].i]++;
  return entries.flatMap(([pillar], i) => Array(counts[i]).fill(pillar));
}

function calendarDates(days) {
  const start = new Date(Date.now() + 86400_000); // start tomorrow
  return Array.from({ length: days }, (_, d) => new Date(start.getTime() + d * 86400_000).toISOString().slice(0, 10));
}

// ── mocks (dynamic — must match requested counts for $0 pipeline runs) ───────
const mockPhantoms = () => JSON.stringify({
  phantoms: Array.from({ length: PHANTOM_COUNT }, (_, i) => ({
    name: ['Maya', 'Jordan', 'Priya', 'Leo', 'Sofia', 'Andre'][i],
    age: 24 + i * 3,
    persona: i % 2 ? 'secondary persona' : 'primary persona',
    appearance: `Synthetic UGC creator ${i + 1}: distinct AI-generated face, casual wardrobe, warm studio light`,
    vibe: ['upbeat', 'dry-witted', 'earnest', 'high-energy', 'calm expert', 'playful'][i],
  })),
});
const mockCampaigns = (n, moments) => JSON.stringify({
  campaigns: Array.from({ length: n }, (_, i) => ({
    title: `Mock Campaign ${i + 1}`,
    type: ['product', 'weather', 'fifa', 'world_event', 'business_event', 'brand', 'educational', 'lifestyle'][i % 8],
    concept: 'A concrete angle grounded in the brand and the moment.',
    visual_design: 'Warm daylight, cream + black palette, handheld UGC feel',
    moment: moments[i % Math.max(moments.length, 1)]?.label || null,
    products: ['Mock Tee'],
  })),
});
// Reel camera/blocking archetypes (mirrors lib/media/render.js SHOT_STYLES) — the
// brief LLM picks one per reel for real runs; mock cycles through all three so a
// $0 run still exercises every style.
const SHOT_STYLE_CYCLE = ['ugc_handheld', 'cinematic_lifestyle', 'bold_studio'];
const mockBriefs = (slots) => {
  let reelIdx = 0;
  return JSON.stringify({
    briefs: slots.map((s) => s.kind === 'reel' ? {
      kind: 'reel',
      hook: 'Stop scrolling — this changes your mornings.',
      script_beats: ['hook on camera', 'product in hand', 'payoff + CTA'],
      shot_style: SHOT_STYLE_CYCLE[reelIdx++ % SHOT_STYLE_CYCLE.length],
      frame_prompts: ['Frame 1: phantom holds product, eye contact, 9:16', 'Frame 2: product close-up in use, 9:16'],
      video_description: 'Handheld selfie energy, quick push-in on product, natural light',
      audio_vibe: 'upbeat summer pop',
      graphics_notes: 'brand logo end-card, one animated stat overlay',
      caption: 'The upgrade your feed asked for. #brand',
      cta: 'Shop the drop',
    } : {
      kind: 'post',
      post_prompt: 'Phantom with product, golden-hour street, candid UGC style, 4:5',
      design_prompt: 'stat-card archetype, oversized number, brand palette',
      caption: 'Numbers don\'t lie.',
      cta: 'Link in bio',
    }),
  });
};

// ── main ──────────────────────────────────────────────────────────────────────
export async function runScriptGen({ intakeId, reels = null, posts = null, regenerate = false }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const slug = intake.tenant_slug;

  // auto-trigger guard: production already exists → skip unless explicit regenerate
  if (pieces.byIntake(intakeId).length > 0 && !regenerate) {
    logEvent({ event: 'scriptgen.skipped_existing', tenantSlug: slug, refId: intakeId, message: 'pieces already exist — pass regenerate to rebuild' });
    return { ok: true, skipped: 'existing production' };
  }
  // published content is a RECORD: once any piece deployed, a full wipe/rebuild is
  // refused (would orphan the deployment history). Per-piece QC regen stays open.
  if (deployments.byIntake(intakeId).length > 0) {
    throw new Error('intake has deployments — full regenerate is blocked; use per-piece QC regeneration instead');
  }
  // proceeding → always rebuild clean (also covers mid-run crash retries)
  pieces.deleteByIntake(intakeId);
  campaigns.deleteByIntake(intakeId);
  phantoms.deleteByIntake(intakeId);

  const cfg = tierConfig(intake.plan) || tierConfig('premium');
  const R = Number.isInteger(reels) && reels > 0 ? reels : cfg.reels;
  const P = Number.isInteger(posts) && posts > 0 ? posts : cfg.posts;
  const scrape = await loadScrapeDoc(intake);
  const brand = {
    name: intake.business_name,
    about: scrape?.about || null,
    voice: scrape?.brand_assets?.voice || null,
    target: scrape?.target_market || null,
    products: (scrape?.products_services?.products || []).map((p) => p.name).slice(0, 12),
    vertical: scrape?.vertical?.vertical || 'other',
  };
  const moments = activeMoments({ location: scrape?.about?.location || '', scrape });
  // QC training loop (Phase 6): last batch's reject reasons brief this batch.
  const learnings = await brandLearningsBlock(slug);
  let calls = 0;
  const spend = async (opts) => {
    if (++calls > BUDGET()) throw new Error(`scriptgen LLM budget exceeded (${BUDGET()} calls)`);
    return llm.complete({ tenant: slug, ...opts });
  };

  // 2. cast the 6 phantoms
  const castRaw = await spend({
    task: 'synthesis',
    system: `You cast synthetic UGC creators for brands. ${PHANTOM_FACE_CONSTRAINT}`,
    prompt: `Cast exactly ${PHANTOM_COUNT} "phantoms" — synthetic UGC creators who collectively embody this brand's target market. Spread age/energy/style across the personas; each must feel like a real, castable person (but explicitly AI-generated — never resembling a specific real individual).

Brand: ${JSON.stringify(brand.about)}
Target market: ${JSON.stringify(brand.target)}

Return ONLY JSON:
{ "phantoms": [ { "name": string, "age": number, "persona": string, "appearance": string, "vibe": string } ] }
appearance = a LOCKED visual description reused verbatim for every image generation (face shape, hair, build, wardrobe baseline, lighting) — specific enough that renders stay consistent.`,
    schema: { type: 'json', required: ['phantoms'], shape: { phantoms: 'array' } },
    mock: mockPhantoms(),
  });
  const castList = JSON.parse(castRaw).phantoms;
  if (castList.length !== PHANTOM_COUNT) throw new Error(`expected ${PHANTOM_COUNT} phantoms, got ${castList.length}`);
  const phantomRows = castList.map((p) => phantoms.cast({
    tenantSlug: slug, intakeId, name: p.name, age: p.age ?? null,
    persona: p.persona ?? null, appearancePrompt: p.appearance, vibe: p.vibe ?? null,
  }));

  // 3. campaign ideation against real moments
  const targetN = Math.min(Math.max(Math.round((R + P) / 6), 1), 30, R + P);
  const ideaRaw = await spend({
    task: 'synthesis',
    system: 'You are Phantom\'s campaign strategist. Ideas must be grounded in the brand data and the listed real-world moments — never invent events.',
    prompt: `Build exactly ${targetN} campaign ideas for ${brand.name}. Each campaign = a cluster of reels + posts sharing ONE visual design. Mix types: product-led, plus moment-riding ones ONLY from the real moments below (weather/season, sports, holidays, business events). ${targetN >= 5 ? 'At least half product-led.' : ''}
Give each campaign a distinct persuasion ANGLE — rotate across proven types rather than repeating one: problem-solution, social proof, authority/expert, before-after transformation, pattern-interrupt hook, comparison, day-in-the-life routine. Name the angle at the start of "concept" (e.g. "Social proof: ...").
${learnings}
Brand: ${JSON.stringify({ about: brand.about, voice: brand.voice, products: brand.products, vertical: brand.vertical })}
Real moments right now: ${JSON.stringify(moments)}

Return ONLY JSON:
{ "campaigns": [ { "title": string, "type": "product"|"weather"|"fifa"|"world_event"|"business_event"|"brand"|"educational"|"lifestyle", "concept": string, "visual_design": string, "moment": string|null, "products": [string] } ] }
visual_design = the shared look (setting, palette, lighting, mood) every piece in the campaign obeys.`,
    schema: { type: 'json', required: ['campaigns'], shape: { campaigns: 'array' } },
    mock: mockCampaigns(targetN, moments),
  });
  let ideaList = JSON.parse(ideaRaw).campaigns.slice(0, 30);
  if (ideaList.length < Math.min(3, targetN)) throw new Error(`campaign ideation returned ${ideaList.length} ideas`);
  const campaignRows = ideaList.map((c) => campaigns.create({
    tenantSlug: slug, intakeId, title: c.title, type: c.type || 'product',
    concept: c.concept, visualDesign: c.visual_design, moment: c.moment ?? null,
    productRefs: Array.isArray(c.products) ? c.products : [],
  }));
  const N = campaignRows.length;

  // 4. deterministic allocation + calendar
  const reelSplit = lrSplit(R, N);
  const postSplit = lrSplit(P, N);
  const pillars = pillarList(P);
  const dates = calendarDates(CAL_DAYS());
  const reelDaily = lrSplit(R, dates.length);
  const postDaily = lrSplit(P, dates.length);
  let pillarIdx = 0; let phantomIdx = 0;
  const slotsByCampaign = campaignRows.map((c, i) => {
    const slots = [];
    for (let k = 0; k < reelSplit[i]; k++) slots.push({ kind: 'reel', phantom: phantomRows[phantomIdx++ % PHANTOM_COUNT] });
    for (let k = 0; k < postSplit[i]; k++) slots.push({ kind: 'post', pillar: pillars[pillarIdx++], phantom: phantomRows[phantomIdx++ % PHANTOM_COUNT] });
    return { campaign: c, slots };
  });

  // 5. per-campaign briefs
  const pieceRows = [];
  for (const { campaign, slots } of slotsByCampaign) {
    if (!slots.length) continue;
    const slotDesc = slots.map((s, i) => `${i + 1}. ${s.kind}${s.pillar ? ` (pillar: ${s.pillar})` : ''} — phantom ${s.phantom.name} (${s.phantom.vibe || 'neutral'})`).join('\n');
    const briefRaw = await spend({
      task: 'extraction',
      system: 'You write production briefs for AI-generated UGC. Every image/video prompt must describe the phantom as a synthetic AI creator consistent with their locked appearance. The image/video generation prompts (frame_prompts, video_description, post_prompt) must NEVER describe on-screen text, captions, subtitles, or graphic overlays — those are composited in a separate post-production stage; graphics_notes is instructions for THAT later stage, not for the generation prompt itself. Output ONLY JSON.',
      prompt: `Write one production brief per slot for this campaign. All pieces share the campaign's visual design.
${learnings}
Campaign: ${JSON.stringify({ title: campaign.title, type: campaign.type, concept: campaign.concept, visual_design: campaign.visual_design, moment: campaign.moment, products: JSON.parse(campaign.product_refs || '[]') })}
Brand voice: ${JSON.stringify(brand.voice)}
Slots:
${slotDesc}

Return ONLY JSON: { "briefs": [ ...one per slot, in order... ] }
reel brief: { "kind":"reel", "hook": string, "script_beats": [string], "shot_style": "ugc_handheld"|"cinematic_lifestyle"|"bold_studio" (pick ONE per reel based on campaign vibe — ugc_handheld: phone-shot selfie energy, direct eye contact; cinematic_lifestyle: smooth aspirational b-roll, phantom not looking at camera; bold_studio: solid-color backdrop, confident direct-to-camera), "frame_prompts": [string] (1-3 MAX, vertical 9:16, phantom + product framing, consistent with shot_style, no on-screen text), "video_description": string (motion/camera for the video model, consistent with shot_style, no on-screen text), "audio_vibe": string (2-4 words for track matching), "graphics_notes": string (overlay/end-card instruction for the separate post-production graphics stage), "caption": string, "cta": string }
post brief: { "kind":"post", "post_prompt": string (image prompt: phantom + product, 4:5, no on-screen text), "design_prompt": string (layout archetype + brand palette direction), "caption": string, "cta": string }`,
      schema: { type: 'json', required: ['briefs'], shape: { briefs: 'array' } },
      mock: mockBriefs(slots),
    });
    const briefs = JSON.parse(briefRaw).briefs;
    if (briefs.length !== slots.length) throw new Error(`campaign "${campaign.title}": ${slots.length} slots but ${briefs.length} briefs`);
    briefs.forEach((b, i) => {
      const s = slots[i];
      if (s.kind === 'reel' && Array.isArray(b.frame_prompts) && b.frame_prompts.length > 3) b.frame_prompts = b.frame_prompts.slice(0, 3); // hard spec cap
      pieceRows.push({
        tenantSlug: slug, intakeId, campaignId: campaign.id, phantomId: s.phantom.id,
        kind: s.kind, pillar: s.pillar ?? null, brief: { ...b, kind: s.kind },
      });
    });
  }

  // calendar assignment: campaign order into per-day quotas (Premium → exactly 1+1/day)
  let dayR = 0, usedR = 0, dayP = 0, usedP = 0;
  for (const row of pieceRows) {
    if (row.kind === 'reel') {
      while (reelDaily[dayR] === 0 || usedR >= reelDaily[dayR]) { dayR++; usedR = 0; }
      row.scheduledDate = dates[dayR]; usedR++;
    } else {
      while (postDaily[dayP] === 0 || usedP >= postDaily[dayP]) { dayP++; usedP = 0; }
      row.scheduledDate = dates[dayP]; usedP++;
    }
  }

  // 6. atomic insert + artifact
  pieces.createMany(pieceRows);
  const artifact = {
    version: 1, intake_id: intakeId, tenant_slug: slug, plan: intake.plan,
    counts: { reels: R, posts: P, campaigns: N, llm_calls: calls },
    learnings_used: learnings.length > 0,
    moments,
    phantoms: phantomRows.map(({ id, name, age, persona, vibe }) => ({ id, name, age, persona, vibe })),
    campaigns: campaignRows.map(({ id, title, type, moment }) => ({ id, title, type, moment })),
  };
  const key = storage.makeKey(slug, 'scrape', 'json'); // scrapes/ folder doubles as intelligence artifacts
  await storage.put(slug, key, Buffer.from(JSON.stringify(artifact, null, 2)), 'application/json');

  events.record({ tenantSlug: slug, name: 'scriptgen.completed', props: { intakeId, reels: R, posts: P, campaigns: N, llmCalls: calls } });
  logEvent({ event: 'scriptgen.completed', tenantSlug: slug, refId: intakeId, message: `${N} campaigns → ${R} reels + ${P} posts over ${dates.length} days (${calls} LLM calls)` });
  // Launch wiring: MEDIA_AUTOGEN=1 chains straight into media generation (the
  // BPMN's hands-free flow). Default OFF — operator clicks Generate with the
  // cost estimate in front of them (v1 spend lesson).
  if (process.env.MEDIA_AUTOGEN === '1') {
    const { generateMedia } = await import('../media/render.js');
    const kicked = generateMedia({ intakeId });
    logEvent({ event: 'media.autogen', tenantSlug: slug, refId: intakeId, message: JSON.stringify(kicked) });
  }
  return { ok: true, reels: R, posts: P, campaigns: N, llmCalls: calls };
}

export function registerScriptGenJobs() {
  jobs.register('script_gen', (payload) => runScriptGen(payload), { concurrency: 1 });
}
