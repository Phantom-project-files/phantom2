// lib/coverage.js — deterministic production-coverage report (Phase 6, $0/no LLM).
// Answers the operator's "did we actually deliver the plan?" in one green/red glance:
// counts vs plan, pillar actual-vs-target, all 6 phantoms used, campaign-type
// spread, QC funnel (ready/approved/rejected/pending).

import { intakes, pieces, phantoms, campaigns } from './db.js';
import { tierConfig, PILLAR_SPLIT } from './tiers.js';

export function coverageReport(intakeId) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const all = pieces.byIntake(intakeId);
  const reels = all.filter((p) => p.kind === 'reel');
  const posts = all.filter((p) => p.kind === 'post');
  const cfg = tierConfig(intake.plan);

  const counts = {
    reels: reels.length, posts: posts.length,
    plan_target: cfg ? { reels: cfg.reels, posts: cfg.posts } : null,
    matches_plan: cfg ? reels.length === cfg.reels && posts.length === cfg.posts : null,
    custom_build: cfg ? !(reels.length === cfg.reels && posts.length === cfg.posts) : true,
  };

  const pillarActual = {};
  for (const p of posts) pillarActual[p.pillar] = (pillarActual[p.pillar] || 0) + 1;
  const pillars = Object.entries(PILLAR_SPLIT).map(([pillar, frac]) => {
    const actual = pillarActual[pillar] || 0;
    const target = posts.length * frac;
    return { pillar, actual, target_pct: Math.round(frac * 100), actual_pct: posts.length ? Math.round((actual / posts.length) * 100) : 0, ok: Math.abs(actual - target) <= 1 };
  });

  const cast = phantoms.byTenant(intake.tenant_slug).filter((p) => p.intake_id === intakeId);
  const usedIds = new Set(all.map((p) => p.phantom_id).filter(Boolean));
  const phantomsBucket = { cast: cast.length, used: usedIds.size, all_used: cast.length > 0 && usedIds.size === cast.length };

  const typeSpread = {};
  for (const c of campaigns.byIntake(intakeId)) typeSpread[c.type] = (typeSpread[c.type] || 0) + 1;

  const statusCounts = {};
  for (const p of all) statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  const qc = {
    ...statusCounts,
    reviewed: (statusCounts.approved || 0) + (statusCounts.rejected || 0),
    pending_review: statusCounts.ready || 0,
  };

  const buckets = {
    counts_ok: all.length > 0,
    pillars_ok: pillars.every((p) => p.ok),
    phantoms_ok: phantomsBucket.all_used,
    production_ok: all.length > 0 && all.every((p) => ['ready', 'approved'].includes(p.status) || p.status === 'rejected'),
  };
  return {
    intake_id: intakeId, plan: intake.plan, counts, pillars, phantoms: phantomsBucket,
    campaign_types: typeSpread, qc, buckets,
    green: Object.values(buckets).every(Boolean),
  };
}
