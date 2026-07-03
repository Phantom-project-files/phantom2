// lib/deploy/index.js — Agent-deploy (Phase 7): calendar-driven publishing.
//
//   connectTenant(slug)        — ensure the tenant's Ayrshare profile + connect URL
//   deploySchedule(intakeId)   — enqueue a deploy_piece job per APPROVED piece;
//                                tier-gated (Standard has deploy:false → gallery/ZIP
//                                only) and entitlement-gated
//   deploy_piece job           — final asset → signed URL → Ayrshare post scheduled
//                                at piece.scheduled_date (Ayrshare fires it)
//
// QC is the gate: only status='approved' pieces deploy — a customer can never get
// an unreviewed piece published (v1's QC_REQUIRED-off spend surprise, inverted).

import { intakes, pieces, mediaAssets, deployments, socialConnections, events } from '../db.js';
import { storage } from '../storage.js';
import { logEvent } from '../logs.js';
import * as jobs from '../jobs.js';
import { tierConfig } from '../tiers.js';
import { isEntitled } from '../entitlement.js';
import * as ayrshare from './ayrshare.js';

const DEFAULT_PLATFORMS = () => (process.env.DEPLOY_PLATFORMS || 'instagram,tiktok').split(',').map((s) => s.trim()).filter(Boolean);

export async function connectTenant(tenantSlug) {
  let conn = socialConnections.get(tenantSlug);
  if (!conn) {
    const { profileKey } = await ayrshare.createProfile(tenantSlug);
    conn = socialConnections.upsert({ tenantSlug, profileKey });
    logEvent({ event: 'deploy.profile_created', tenantSlug, message: ayrshare.isMock() ? 'mock profile' : 'ayrshare profile created' });
  }
  const { url } = await ayrshare.connectUrl(conn.ayrshare_profile_key);
  const platforms = await ayrshare.linkedPlatforms(conn.ayrshare_profile_key);
  conn = socialConnections.upsert({
    tenantSlug, profileKey: conn.ayrshare_profile_key,
    platforms, status: platforms.length ? 'linked' : 'created',
  });
  return { connection: conn, connect_url: url, platforms };
}

export function deploySchedule({ intakeId, platforms = null, pieceIds = null }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  if (!isEntitled(intake)) throw new Error('payment required before deploy');
  const cfg = tierConfig(intake.plan);
  if (cfg && !cfg.deploy) throw new Error(`plan '${intake.plan}' has no auto-deploy — use gallery/ZIP delivery`);
  const conn = socialConnections.get(intake.tenant_slug);
  if (!conn) throw new Error('connect socials first (no Ayrshare profile for tenant)');

  const targets = pieces.byIntake(intakeId).filter((p) =>
    p.status === 'approved'
    && (!pieceIds || pieceIds.includes(p.id))
    && !deployments.activeByPiece(p.id));
  let queued = 0;
  for (const p of targets) {
    jobs.enqueue({
      kind: 'deploy_piece', tenantSlug: intake.tenant_slug, refKind: 'piece', refId: p.id,
      payload: { pieceId: p.id, platforms: platforms || DEFAULT_PLATFORMS() }, maxAttempts: 3,
    });
    queued++;
  }
  events.record({ tenantSlug: intake.tenant_slug, name: 'deploy.schedule_kicked', props: { intakeId, queued } });
  logEvent({ event: 'deploy.schedule_kicked', tenantSlug: intake.tenant_slug, refId: intakeId, message: `${queued} approved piece(s) queued for calendar deploy` });
  return { queued, skipped_unapproved: pieces.byIntake(intakeId).filter((p) => p.status === 'ready').length };
}

async function handleDeployPiece({ pieceId, platforms }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (piece.status !== 'approved') return { skipped: `piece is '${piece.status}', not approved` };
  const conn = socialConnections.get(piece.tenant_slug);
  if (!conn) throw new Error('tenant has no social connection');

  const finalKind = piece.kind === 'reel' ? 'reel' : 'post_final';
  const asset = mediaAssets.byRef('piece', piece.id).find((a) => a.kind === finalKind);
  if (!asset) {
    const err = new Error(`final ${finalKind} asset not present yet`);
    err.retryable = true; err.retryAfterSec = 10;
    throw err;
  }
  // Ayrshare must be able to fetch the media — long-lived signed URL (2h).
  const mediaUrl = ayrshare.isMock() ? `mock://media/${asset.id}` : await storage.signedGet(piece.tenant_slug, asset.r2_key, 7200);
  const brief = JSON.parse(piece.brief);
  const caption = [brief.caption, brief.cta].filter(Boolean).join(' — ').slice(0, 2200);
  // schedule at 10:00 local-ish (UTC compromise) on the piece's calendar day; past dates post now
  const when = new Date(`${piece.scheduled_date}T10:00:00Z`);
  const scheduleDate = when.getTime() > Date.now() + 60_000 ? when.toISOString() : null;

  const res = await ayrshare.publishPost({
    profileKey: conn.ayrshare_profile_key, caption,
    mediaUrls: [mediaUrl], platforms, scheduleDate, isVideo: piece.kind === 'reel',
  });
  const depId = deployments.create({
    tenantSlug: piece.tenant_slug, intakeId: piece.intake_id, pieceId: piece.id,
    platforms, scheduledAt: scheduleDate || new Date().toISOString(),
    status: scheduleDate ? 'scheduled' : 'published', postId: res.id,
  });
  events.record({ tenantSlug: piece.tenant_slug, name: 'deploy.piece', props: { pieceId: piece.id, deploymentId: depId, scheduled: !!scheduleDate } });
  return { deploymentId: depId, postId: res.id, scheduled: !!scheduleDate };
}

export function registerDeployJobs() {
  jobs.register('deploy_piece', handleDeployPiece, { concurrency: 3 });
}
