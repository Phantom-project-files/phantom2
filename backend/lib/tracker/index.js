// lib/tracker/index.js — Agent-tracker (Phase 7): metrics → month-end report →
// learnings + upgrade offer. The BPMN's compounding loop closed:
//
//   track_metrics job     — snapshot Ayrshare analytics for published deployments
//   runMonthEndReport()   — aggregate the period → winners/losers by engagement →
//                           summary-tier LLM narrative + performance_rules →
//                           reports row + month_end_report email (+ upgrade_offer
//                           email when the volume ceiling argues for the next tier)
//   performanceRules()    — the tracker side of <brand_learnings>: qc-learnings
//                           pulls these so next month's briefs know what PERFORMED,
//                           not just what the operator rejected.

import { intakes, pieces, deployments, socialConnections, metrics, reports, events, campaigns } from '../db.js';
import { logEvent } from '../logs.js';
import * as jobs from '../jobs.js';
import { llm } from '../llm.js';
import { TIERS, tierConfig } from '../tiers.js';
import { sendEmail } from '../email.js';
import * as ayrshare from '../deploy/ayrshare.js';

export function registerTrackerJobs() {
  jobs.register('track_metrics', handleTrackMetrics, { concurrency: 2 });
}

async function handleTrackMetrics({ tenantSlug }) {
  const conn = socialConnections.get(tenantSlug);
  if (!conn) return { skipped: 'no social connection' };
  // scheduled + published: analytics succeeding for a "scheduled" post means
  // Ayrshare has fired it — implicit status sync, no separate status poll.
  const targets = [...deployments.byTenantStatus(tenantSlug, 'published'), ...deployments.byTenantStatus(tenantSlug, 'scheduled')];
  let captured = 0;
  for (const dep of targets) {
    if (!dep.ayrshare_post_id) continue;
    try {
      const a = await ayrshare.postAnalytics({ profileKey: conn.ayrshare_profile_key, postId: dep.ayrshare_post_id });
      if (dep.status === 'scheduled') deployments.mark(dep.id, 'published');
      for (const [platform, m] of Object.entries(a)) {
        if (!m || typeof m !== 'object') continue;
        metrics.record({
          tenantSlug, deploymentId: dep.id, pieceId: dep.piece_id, platform,
          views: m.views ?? m.impressions ?? null, likes: m.likes ?? null,
          comments: m.comments ?? null, shares: m.shares ?? null, meta: m,
        });
        captured++;
      }
    } catch (err) {
      // scheduled + analytics error = not fired yet (expected); published + error = warn
      if (dep.status === 'published') logEvent({ level: 'warn', event: 'tracker.analytics_failed', tenantSlug, refId: dep.id, message: err.message });
    }
  }
  logEvent({ event: 'tracker.captured', tenantSlug, message: `${captured} metric row(s) from ${targets.length} deployment(s)` });
  return { captured };
}

const MOCK_NARRATIVE = JSON.stringify({
  narrative: 'Reels carried the month — product-led campaigns doubled the engagement of lifestyle posts.',
  performance_rules: ['Prefer product-led reel hooks — they outperformed 2:1.', 'Avoid lifestyle posts without a product anchor.'],
});

export async function runMonthEndReport({ tenantSlug, period = null }) {
  const now = new Date();
  const p = period || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const since = Math.floor(new Date(`${p}-01T00:00:00Z`).getTime() / 1000);
  const rows = metrics.byTenantSince(tenantSlug, since);
  const intake = intakes.list(200).find((i) => i.tenant_slug === tenantSlug) || null;

  // aggregate per piece
  const perPiece = new Map();
  for (const m of rows) {
    const cur = perPiece.get(m.piece_id) || { piece_id: m.piece_id, views: 0, likes: 0, comments: 0, shares: 0 };
    cur.views += m.views || 0; cur.likes += m.likes || 0; cur.comments += m.comments || 0; cur.shares += m.shares || 0;
    perPiece.set(m.piece_id, cur);
  }
  const scored = [...perPiece.values()].map((x) => ({
    ...x,
    engagement: x.likes + 2 * x.comments + 3 * x.shares,
    piece: pieces.byId(x.piece_id),
  })).filter((x) => x.piece);
  scored.sort((a, b) => b.engagement - a.engagement);
  const campMap = Object.fromEntries((intake ? campaigns.byIntake(intake.id) : []).map((c) => [c.id, c]));
  const describe = (x) => ({
    piece_id: x.piece_id, kind: x.piece.kind, pillar: x.piece.pillar,
    campaign: campMap[x.piece.campaign_id]?.title || null, campaign_type: campMap[x.piece.campaign_id]?.type || null,
    views: x.views, engagement: x.engagement,
  });
  const winners = scored.slice(0, 5).map(describe);
  const losers = scored.slice(-3).reverse().map(describe);
  const totals = scored.reduce((t, x) => ({ views: t.views + x.views, engagement: t.engagement + x.engagement }), { views: 0, engagement: 0 });

  // narrative + rules (summary tier, mock-friendly)
  let narrative = null; let performanceRules = [];
  if (scored.length) {
    try {
      const raw = await llm.complete({
        task: 'summary',
        system: 'You write month-end content-performance summaries. Output ONLY JSON.',
        prompt: `Summarize this month for the brand and derive at most 4 imperative production rules from what performed vs what did not.
Winners: ${JSON.stringify(winners)}
Underperformers: ${JSON.stringify(losers)}
Totals: ${JSON.stringify(totals)} across ${scored.length} deployed pieces.
Return ONLY JSON: { "narrative": string, "performance_rules": [string] }`,
        schema: { type: 'json', required: ['narrative', 'performance_rules'] },
        tenant: tenantSlug,
        mock: MOCK_NARRATIVE,
      });
      const parsed = JSON.parse(raw);
      narrative = parsed.narrative;
      performanceRules = (parsed.performance_rules || []).slice(0, 4);
    } catch (err) {
      logEvent({ level: 'warn', event: 'tracker.narrative_failed', tenantSlug, message: err.message });
    }
  }

  // upgrade offer (BPMN "exclusive upgrade offer"): plan ceiling + real traction
  const plan = intake?.plan || 'premium';
  const nextTier = TIERS[TIERS.indexOf(plan) + 1] || null;
  const cfg = tierConfig(plan);
  const upsell = !!nextTier && scored.length >= (cfg ? Math.min(cfg.reels, 10) : 10) && totals.engagement > 0;

  const summary = {
    period: p, deployed_pieces: scored.length, totals, winners, losers,
    narrative, performance_rules: performanceRules,
    upsell: upsell ? { to: nextTier, reason: 'volume ceiling + real engagement — more shots on goal' } : null,
  };
  const report = reports.upsert(tenantSlug, intake?.id || null, p, summary);
  events.record({ tenantSlug, name: 'tracker.month_end', props: { period: p, pieces: scored.length, upsell: !!upsell } });
  logEvent({ event: 'tracker.month_end', tenantSlug, message: `${p}: ${scored.length} pieces, engagement ${totals.engagement}${upsell ? `, upsell → ${nextTier}` : ''}` });
  if (intake) {
    sendEmail({ intakeId: intake.id, template: 'month_end_report', tenantSlug, data: { period: p } });
    if (upsell) sendEmail({ intakeId: intake.id, template: 'upgrade_offer', tenantSlug, data: { to: nextTier } });
  }
  return { report: summary, report_id: report.id };
}

// The tracker's contribution to <brand_learnings> (qc-learnings merges these in).
export function performanceRules(tenantSlug) {
  const latest = reports.latest(tenantSlug);
  if (!latest) return [];
  try { return JSON.parse(latest.summary).performance_rules || []; } catch { return []; }
}
