// lib/qc.js — Agent-QC (Phase 6): flag → regenerate, hard max 3 (operator spec).
//
// applyVerdict() is the single entry for piece QC:
//   approve → status 'approved' + verdict row (the positive training signal)
//   reject  → verdict row with reason_text/tags, then:
//               regen_count < 3 → feedback written into brief.regen_feedback
//               (render prompts inject it — v1's dropped-feedback bug stays fixed),
//               old artifacts soft-deleted, piece re-enters the render queue
//               regen_count ≥ 3 → status 'rejected' (cap reached; operator handles
//               manually — the cap is a COST guard, not a quality ceiling)
//
// phantomVerdict(): reject a face → soft-delete the ref, re-render with the
// feedback appended as an AVOID note (the locked appearance_prompt itself never
// mutates — consistency contract survives regens).

import { pieces, phantoms, mediaAssets, qcVerdicts, events, intakes } from './db.js';
import { logEvent } from './logs.js';
import * as jobs from './jobs.js';

export const REGEN_CAP = 3;
export const REASON_TAGS = ['face_quality', 'caption', 'brand_tone', 'off_pillar', 'product', 'motion', 'audio'];

function softDeletePieceArtifacts(piece) {
  let n = 0;
  for (const a of mediaAssets.byRef('piece', piece.id)) { mediaAssets.softDelete(a.id); n++; }
  if (piece.kind === 'reel') {
    // fresh shots live under the campaign ref — only this piece's own
    for (const a of mediaAssets.byRef('campaign', piece.campaign_id)) {
      const m = JSON.parse(a.meta || '{}');
      if (a.kind === 'shot' && m.source_piece_id === piece.id) { mediaAssets.softDelete(a.id); n++; }
    }
  }
  return n;
}

export function applyVerdict({ pieceId, verdict, reasonText = null, reasonTags = null, actor = 'operator' }) {
  const piece = pieces.byId(pieceId);
  if (!piece) throw new Error(`piece ${pieceId} not found`);
  if (!['approve', 'reject'].includes(verdict)) throw new Error("verdict must be 'approve' | 'reject'");
  const tags = Array.isArray(reasonTags) ? reasonTags.filter((t) => REASON_TAGS.includes(t)) : null;

  qcVerdicts.record({
    tenantSlug: piece.tenant_slug, intakeId: piece.intake_id, pieceId: piece.id,
    kind: piece.kind, verdict, reasonText, reasonTags: tags, actor,
  });

  if (verdict === 'approve') {
    pieces.setStatus(piece.id, 'approved');
    events.record({ tenantSlug: piece.tenant_slug, name: 'qc.approved', props: { pieceId: piece.id, kind: piece.kind } });
    return { status: 'approved' };
  }

  // reject
  if (piece.regen_count >= REGEN_CAP) {
    pieces.setStatus(piece.id, 'rejected');
    events.record({ tenantSlug: piece.tenant_slug, name: 'qc.rejected_capped', props: { pieceId: piece.id, regens: piece.regen_count } });
    logEvent({ level: 'warn', event: 'qc.regen_cap', tenantSlug: piece.tenant_slug, refId: piece.id, message: `piece hit the ${REGEN_CAP}-regen cap — manual intervention` });
    return { status: 'rejected', capped: true, regen_count: piece.regen_count };
  }

  // feedback → brief (render prompts read brief.regen_feedback)
  const brief = JSON.parse(piece.brief);
  brief.regen_feedback = [reasonText, tags?.length ? `tags: ${tags.join(', ')}` : null].filter(Boolean).join(' — ') || 'operator flagged — improve overall quality';
  pieces.updateBrief(piece.id, brief);
  const cleaned = softDeletePieceArtifacts(piece);
  pieces.incrementRegen(piece.id);
  jobs.enqueue({
    kind: piece.kind === 'reel' ? 'render_reel' : 'render_post',
    tenantSlug: piece.tenant_slug, refKind: 'piece', refId: piece.id,
    payload: { pieceId: piece.id }, maxAttempts: 6,
  });
  events.record({ tenantSlug: piece.tenant_slug, name: 'qc.regen', props: { pieceId: piece.id, regen: piece.regen_count + 1, tags } });
  logEvent({ event: 'qc.regen', tenantSlug: piece.tenant_slug, refId: piece.id, message: `regen ${piece.regen_count + 1}/${REGEN_CAP} — ${brief.regen_feedback.slice(0, 120)} (${cleaned} artifacts cleared)` });
  return { status: 'rendering', regen: piece.regen_count + 1, cap: REGEN_CAP };
}

export function phantomVerdict({ phantomId, verdict, reasonText = null, actor = 'operator' }) {
  const ph = phantoms.byId(phantomId);
  if (!ph) throw new Error(`phantom ${phantomId} not found`);
  qcVerdicts.record({
    tenantSlug: ph.tenant_slug, intakeId: ph.intake_id, phantomId: ph.id,
    kind: 'phantom', verdict, reasonText, actor,
  });
  if (verdict === 'approve') return { status: ph.status };
  for (const a of mediaAssets.byRef('phantom', ph.id)) mediaAssets.softDelete(a.id);
  phantoms.setStatus(ph.id, 'rendering');
  jobs.enqueue({
    kind: 'render_phantom', tenantSlug: ph.tenant_slug, refKind: 'phantom', refId: ph.id,
    payload: { phantomId: ph.id, feedback: reasonText || 'operator flagged — recast' }, maxAttempts: 3,
  });
  events.record({ tenantSlug: ph.tenant_slug, name: 'qc.phantom_regen', props: { phantomId: ph.id } });
  return { status: 'rendering' };
}
