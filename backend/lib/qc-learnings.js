// lib/qc-learnings.js — reject reasons → next-batch briefing (v1 Phase-5 port).
//
// rollup(slug)            — deterministic: approval rate, top reason_tags, recent
//                           reject reasons. $0, always available.
// brandLearningsBlock(slug) — ≤6 imperative "avoid/prefer" bullets, summarized by
//                           the summary tier (Haiku) and VOLUME-CACHED by verdict
//                           count (re-summarize only when new verdicts landed).
//                           Script-gen injects the block into ideation + brief
//                           prompts, so every batch is briefed by the last one's
//                           rejections — quality compounds per brand.

import { qcVerdicts, qcLearningsCache } from './db.js';
import { llm } from './llm.js';
import { logEvent } from './logs.js';

export function rollup(tenantSlug) {
  const rows = qcVerdicts.byTenant(tenantSlug, 500);
  if (!rows.length) return null;
  const approves = rows.filter((r) => r.verdict === 'approve').length;
  const rejects = rows.filter((r) => r.verdict === 'reject');
  const tagCounts = {};
  for (const r of rejects) {
    for (const t of (() => { try { return JSON.parse(r.reason_tags || '[]'); } catch { return []; } })()) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  return {
    total: rows.length,
    approval_rate: Math.round((approves / rows.length) * 100) / 100,
    top_tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, n]) => ({ tag, n })),
    recent_reasons: rejects.slice(0, 10).map((r) => ({ kind: r.kind, text: r.reason_text })).filter((r) => r.text),
  };
}

const MOCK_BULLETS = JSON.stringify({
  bullets: ['Avoid stiff studio poses — keep phantoms candid.', 'Prefer captions under 12 words.'],
});

export async function summarizeLearnings(tenantSlug) {
  const count = qcVerdicts.countByTenant(tenantSlug);
  if (count === 0) return [];
  const cached = qcLearningsCache.get(tenantSlug);
  if (cached && cached.verdict_count === count) {
    try { return JSON.parse(cached.bullets); } catch { /* refresh below */ }
  }
  const r = rollup(tenantSlug);
  try {
    const raw = await llm.complete({
      task: 'summary',
      system: 'You distill content-QC feedback into brief production rules. Output ONLY JSON.',
      prompt: `Turn this brand's QC history into at most 6 short imperative rules ("Avoid …" / "Prefer …") for the next content batch. Only rules the evidence supports.

QC rollup: ${JSON.stringify(r)}

Return ONLY JSON: { "bullets": [string] }`,
      schema: { type: 'json', required: ['bullets'], shape: { bullets: 'array' } },
      tenant: tenantSlug,
      mock: MOCK_BULLETS,
    });
    const bullets = JSON.parse(raw).bullets.slice(0, 6);
    qcLearningsCache.set(tenantSlug, count, bullets);
    return bullets;
  } catch (err) {
    logEvent({ level: 'warn', event: 'qc.learnings_summarize_failed', tenantSlug, message: err.message });
    // deterministic fallback: top tags become blunt rules
    return (r?.top_tags || []).slice(0, 4).map(({ tag }) => `Address recurring '${tag}' rejections.`);
  }
}

// The block script-gen injects: QC rules + the tracker's month-end performance
// rules (Phase 7) — what the operator rejected AND what the audience rewarded.
export async function brandLearningsBlock(tenantSlug) {
  const bullets = await summarizeLearnings(tenantSlug);
  let perf = [];
  try {
    const { performanceRules } = await import('./tracker/index.js');
    perf = performanceRules(tenantSlug);
  } catch { /* tracker optional at import time */ }
  if (!bullets.length && !perf.length) return '';
  const lines = [
    ...bullets.map((b) => `- ${b}`),
    ...perf.map((b) => `- [performance] ${b}`),
  ];
  return `\n<brand_learnings>\nQC + month-end performance history for this brand — every new piece MUST respect these:\n${lines.join('\n')}\n</brand_learnings>\n`;
}
