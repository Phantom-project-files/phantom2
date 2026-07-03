// lib/promote.js — local → prod tenant promotion (Phase 8).
//
// The operator's workflow: run the whole pipeline LOCALLY on the Max subscription
// (CLAUDE_MODE=claude_code, $0 API) with local storage, review everything, then
// promote the finished tenant to prod in one move:
//
//   scripts/promote-tenant.js <slug> --to https://prod --user X --pass Y
//     1. exportTenantBundle(slug)        — rows: tenant/intake/phantoms/campaigns/
//                                          pieces/qc_verdicts/media_assets (faithful
//                                          copies incl. status + regen counts)
//     2. POST /api/admin/import/tenant   — prod inserts with INTEGER IDS REMAPPED
//                                          (autoincrements differ) + returns the
//                                          media manifest (R2 keys to upload)
//     3. PUT /api/admin/import/media     — raw bytes per key → prod storage (R2)
//
// Slug collision on prod → 409 (local slugs carry nanoid suffixes, so in practice
// promote is append-only; no destructive overwrite path on purpose).
// Deployments/metrics/reports are NOT promoted — those are prod-runtime concerns.

import { db, tenants } from './db.js';
import { logEvent } from './logs.js';

const rows = (sql, ...args) => db.prepare(sql).all(...args);

export function exportTenantBundle(slug) {
  const tenant = tenants.bySlug(slug);
  if (!tenant) throw new Error(`tenant '${slug}' not found`);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    tenant,
    intakes: rows('SELECT * FROM intakes WHERE tenant_slug = ?', slug),
    phantoms: rows('SELECT * FROM phantoms WHERE tenant_slug = ?', slug),
    campaigns: rows('SELECT * FROM campaigns WHERE tenant_slug = ?', slug),
    pieces: rows('SELECT * FROM pieces WHERE tenant_slug = ?', slug),
    qc_verdicts: rows('SELECT * FROM qc_verdicts WHERE tenant_slug = ?', slug),
    media_assets: rows("SELECT * FROM media_assets WHERE tenant_slug = ? AND status = 'active'", slug),
  };
}

// Insert the bundle with integer ids remapped. Returns { slug, media_manifest }.
export function importTenantBundle(bundle) {
  if (bundle?.version !== 1) throw new Error('unsupported bundle version');
  const slug = bundle.tenant?.slug;
  if (!slug) throw new Error('bundle has no tenant');
  if (tenants.bySlug(slug)) {
    const err = new Error(`tenant '${slug}' already exists on this instance`);
    err.status = 409;
    throw err;
  }

  const phantomMap = new Map();
  const campaignMap = new Map();
  const pieceMap = new Map();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO tenants (slug, business_name, website, status, vertical, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(slug, bundle.tenant.business_name, bundle.tenant.website, bundle.tenant.status, bundle.tenant.vertical, bundle.tenant.created_at);
    for (const i of bundle.intakes) {
      db.prepare(`INSERT INTO intakes (id, tenant_slug, business_name, website, status, scrape_key, llm_calls, flags, error,
                    value_prop, plan, payment_status, paid_at, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(i.id, slug, i.business_name, i.website, i.status, i.scrape_key, i.llm_calls, i.flags, i.error,
          i.value_prop, i.plan, i.payment_status, i.paid_at, i.created_at, i.updated_at);
    }
    for (const p of bundle.phantoms) {
      const r = db.prepare(`INSERT INTO phantoms (tenant_slug, intake_id, name, age, persona, appearance_prompt, vibe, ref_image_key, status, synthetic, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(slug, p.intake_id, p.name, p.age, p.persona, p.appearance_prompt, p.vibe, p.ref_image_key, p.status, p.synthetic, p.created_at);
      phantomMap.set(p.id, r.lastInsertRowid);
    }
    for (const c of bundle.campaigns) {
      const r = db.prepare(`INSERT INTO campaigns (tenant_slug, intake_id, title, type, concept, visual_design, moment, product_refs, status, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(slug, c.intake_id, c.title, c.type, c.concept, c.visual_design, c.moment, c.product_refs, c.status, c.created_at);
      campaignMap.set(c.id, r.lastInsertRowid);
    }
    for (const p of bundle.pieces) {
      const r = db.prepare(`INSERT INTO pieces (tenant_slug, intake_id, campaign_id, phantom_id, kind, pillar, scheduled_date, brief, status, regen_count, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(slug, p.intake_id, campaignMap.get(p.campaign_id), p.phantom_id ? phantomMap.get(p.phantom_id) : null,
          p.kind, p.pillar, p.scheduled_date, p.brief, p.status, p.regen_count, p.created_at);
      pieceMap.set(p.id, r.lastInsertRowid);
    }
    for (const v of bundle.qc_verdicts) {
      db.prepare(`INSERT INTO qc_verdicts (tenant_slug, intake_id, piece_id, phantom_id, kind, verdict, reason_text, reason_tags, actor, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(slug, v.intake_id, v.piece_id ? pieceMap.get(v.piece_id) : null,
          v.phantom_id ? phantomMap.get(v.phantom_id) : null,
          v.kind, v.verdict, v.reason_text, v.reason_tags, v.actor, v.created_at);
    }
    for (const a of bundle.media_assets) {
      // remap piece/phantom/campaign refs; r2 keys travel verbatim (tenant-prefixed + unique)
      let refId = a.ref_id;
      if (a.ref_kind === 'piece' && pieceMap.has(Number(a.ref_id))) refId = String(pieceMap.get(Number(a.ref_id)));
      if (a.ref_kind === 'phantom' && phantomMap.has(Number(a.ref_id))) refId = String(phantomMap.get(Number(a.ref_id)));
      if (a.ref_kind === 'campaign' && campaignMap.has(Number(a.ref_id))) refId = String(campaignMap.get(Number(a.ref_id)));
      let meta = a.meta;
      try {
        const m = JSON.parse(a.meta || 'null');
        if (m) {
          if (m.source_piece_id && pieceMap.has(m.source_piece_id)) m.source_piece_id = pieceMap.get(m.source_piece_id);
          if (m.campaign_id && campaignMap.has(m.campaign_id)) m.campaign_id = campaignMap.get(m.campaign_id);
          if (m.piece_id && pieceMap.has(m.piece_id)) m.piece_id = pieceMap.get(m.piece_id);
          if (m.phantom_id && phantomMap.has(m.phantom_id)) m.phantom_id = phantomMap.get(m.phantom_id);
          meta = JSON.stringify(m);
        }
      } catch { /* keep raw */ }
      db.prepare(`INSERT INTO media_assets (tenant_slug, kind, r2_key, content_type, size_bytes, sha256, ref_kind, ref_id, status, created_at, meta)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(slug, a.kind, a.r2_key, a.content_type, a.size_bytes, a.sha256, a.ref_kind, refId, a.created_at, meta);
    }
  });
  tx();

  const media_manifest = bundle.media_assets.map((a) => ({ r2_key: a.r2_key, content_type: a.content_type, size_bytes: a.size_bytes }));
  logEvent({ event: 'promote.imported', tenantSlug: slug, message: `${bundle.pieces.length} pieces, ${bundle.media_assets.length} media rows — awaiting ${media_manifest.length} file upload(s)` });
  return { slug, counts: { phantoms: phantomMap.size, campaigns: campaignMap.size, pieces: pieceMap.size, media: media_manifest.length }, media_manifest };
}
