// lib/db.js — SQLite bootstrap + migrations + typed accessors (Phantom 2.0).
//
// v1-proven pattern: better-sqlite3, WAL, numbered .sql migrations applied in a
// transaction at import time, accessors as small prepared-statement objects.
// DB path: $PHANTOM_DB_PATH (prod: /data/phantom2.db on the Fly volume) or
// backend/data/phantom2.db locally.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.PHANTOM_DB_PATH
  || path.join(__dirname, '..', 'data', 'phantom2.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ── migrations ────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  if (applied.has(f)) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
  const run = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
  });
  run();
  console.log(`[db] applied migration ${f}`);
}

const now = () => Math.floor(Date.now() / 1000);

// ── admins ────────────────────────────────────────────────────────────────────
const _adminCreateInvite = db.prepare(`
  INSERT INTO admins (email, name, role, invite_token, invite_expires, invited_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _adminById = db.prepare('SELECT * FROM admins WHERE id = ?');
const _adminByEmail = db.prepare('SELECT * FROM admins WHERE email = ?');
const _adminByInviteToken = db.prepare("SELECT * FROM admins WHERE invite_token = ? AND status = 'invited'");
const _adminAcceptInvite = db.prepare(`
  UPDATE admins SET password_hash = ?, name = COALESCE(?, name), status = 'active',
                    invite_token = NULL, invite_expires = NULL,
                    accepted_at = strftime('%s','now')
   WHERE id = ? AND status = 'invited'
`);
const _adminTouchLogin = db.prepare("UPDATE admins SET last_login_at = strftime('%s','now') WHERE id = ?");
const _adminList = db.prepare('SELECT id, email, name, role, status, created_at, last_login_at FROM admins ORDER BY id');
const _adminCount = db.prepare("SELECT COUNT(*) AS n FROM admins WHERE status = 'active'");
const _adminUpsertActive = db.prepare(`
  INSERT INTO admins (email, name, role, status, password_hash)
  VALUES (@email, @name, @role, 'active', @password_hash)
  ON CONFLICT(email) DO UPDATE SET
    name = COALESCE(excluded.name, name), role = excluded.role,
    status = 'active', password_hash = excluded.password_hash
`);

export const admins = {
  createInvite({ email, name = null, role = 'admin', token, expiresAt, invitedBy = null }) {
    const r = _adminCreateInvite.run(email, name, role, token, expiresAt, invitedBy);
    return _adminById.get(r.lastInsertRowid);
  },
  byId(id) { return _adminById.get(id) || null; },
  byEmail(email) { return _adminByEmail.get(email) || null; },
  byInviteToken(token) { return _adminByInviteToken.get(token) || null; },
  acceptInvite(id, { passwordHash, name = null }) {
    return _adminAcceptInvite.run(passwordHash, name, id).changes > 0;
  },
  touchLogin(id) { _adminTouchLogin.run(id); },
  list() { return _adminList.all(); },
  countActive() { return _adminCount.get().n; },
  ensureActive({ email, name = null, role = 'owner', passwordHash = null }) {
    _adminUpsertActive.run({ email, name, role, password_hash: passwordHash });
    return _adminByEmail.get(email);
  },
};

// ── admin_sessions ────────────────────────────────────────────────────────────
const _sessionInsert = db.prepare(`
  INSERT INTO admin_sessions (id, admin_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)
`);
const _sessionFind = db.prepare(`
  SELECT s.*, a.email AS admin_email, a.name AS admin_name, a.role AS admin_role,
         a.status AS admin_status
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
   WHERE s.id = ? AND s.expires_at > strftime('%s','now')
`);
const _sessionTouch = db.prepare("UPDATE admin_sessions SET last_seen_at = strftime('%s','now') WHERE id = ?");
const _sessionDelete = db.prepare('DELETE FROM admin_sessions WHERE id = ?');
const _sessionPurge = db.prepare("DELETE FROM admin_sessions WHERE expires_at <= strftime('%s','now')");

export const adminSessions = {
  create({ id, adminId, ttlSeconds, ip = null, userAgent = null }) {
    const expiresAt = now() + ttlSeconds;
    _sessionInsert.run(id, adminId, expiresAt, ip, userAgent);
    return { id, adminId, expiresAt };
  },
  find(id) {
    const row = _sessionFind.get(id);
    if (!row) return null;
    if (row.admin_status !== 'active') return null;
    return row;
  },
  touch(id) { _sessionTouch.run(id); },
  destroy(id) { _sessionDelete.run(id); },
  purgeExpired() { return _sessionPurge.run().changes; },
};

// ── users / orgs / user_sessions (Google OAuth customers) ────────────────────
const _userByGoogleSub = db.prepare('SELECT * FROM users WHERE google_sub = ?');
const _userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const _userById = db.prepare('SELECT * FROM users WHERE id = ?');
const _userInsert = db.prepare(`
  INSERT INTO users (org_id, email, name, google_sub, avatar_url, last_login_at)
  VALUES (NULL, ?, ?, ?, ?, strftime('%s','now'))
`);
const _userAttachGoogle = db.prepare(`
  UPDATE users SET google_sub = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url),
                   last_login_at = strftime('%s','now') WHERE id = ?
`);
const _userTouch = db.prepare("UPDATE users SET last_login_at = strftime('%s','now'), name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?");
const _userSetOrg = db.prepare('UPDATE users SET org_id = ? WHERE id = ?');

export const users = {
  byId(id) { return _userById.get(id) || null; },
  upsertFromGoogle({ sub, email, name = null, picture = null }) {
    const lc = String(email).toLowerCase();
    let row = _userByGoogleSub.get(sub);
    if (row) { _userTouch.run(name, picture, row.id); return _userById.get(row.id); }
    row = _userByEmail.get(lc);
    if (row) { _userAttachGoogle.run(sub, name, picture, row.id); return _userById.get(row.id); }
    const r = _userInsert.run(lc, name, sub, picture);
    return _userById.get(r.lastInsertRowid);
  },
  setOrg(userId, orgId) { _userSetOrg.run(orgId, userId); },
};

const _orgInsert = db.prepare('INSERT INTO orgs (name) VALUES (?)');
const _orgById = db.prepare('SELECT * FROM orgs WHERE id = ?');
export const orgs = {
  create(name) { const r = _orgInsert.run(name); return _orgById.get(r.lastInsertRowid); },
  byId(id) { return _orgById.get(id) || null; },
};

const _usessionInsert = db.prepare('INSERT INTO user_sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)');
const _usessionFind = db.prepare(`
  SELECT s.*, u.email AS user_email, u.name AS user_name, u.org_id AS user_org_id
    FROM user_sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id = ? AND s.expires_at > strftime('%s','now')
`);
const _usessionDelete = db.prepare('DELETE FROM user_sessions WHERE id = ?');
export const userSessions = {
  create({ id, userId, ttlSeconds, ip = null, userAgent = null }) {
    _usessionInsert.run(id, userId, now() + ttlSeconds, ip, userAgent);
    return { id };
  },
  find(id) { return _usessionFind.get(id) || null; },
  destroy(id) { _usessionDelete.run(id); },
};

// ── purchases ─────────────────────────────────────────────────────────────────
const _purchaseInsert = db.prepare(`
  INSERT INTO purchases (intake_id, tenant_slug, org_id, plan, amount_usd, recurring, stripe_session_id)
  VALUES (@intake_id, @tenant_slug, @org_id, @plan, @amount_usd, @recurring, @stripe_session_id)
`);
const _purchaseBySession = db.prepare('SELECT * FROM purchases WHERE stripe_session_id = ?');
const _purchaseMarkPaid = db.prepare(`
  UPDATE purchases SET status = ?, paid_at = strftime('%s','now') WHERE id = ?
`);
const _purchasesByIntake = db.prepare('SELECT * FROM purchases WHERE intake_id = ? ORDER BY id DESC');

export const purchases = {
  create({ intakeId, tenantSlug, orgId = null, plan, amountUsd, recurring, stripeSessionId = null }) {
    const r = _purchaseInsert.run({
      intake_id: intakeId, tenant_slug: tenantSlug, org_id: orgId, plan,
      amount_usd: amountUsd, recurring: recurring ? 1 : 0, stripe_session_id: stripeSessionId,
    });
    return r.lastInsertRowid;
  },
  bySessionId(sid) { return _purchaseBySession.get(sid) || null; },
  markPaid(id, status = 'paid') { _purchaseMarkPaid.run(status, id); },
  byIntake(intakeId) { return _purchasesByIntake.all(intakeId); },
};

// ── events (user journey) ─────────────────────────────────────────────────────
const _eventInsert = db.prepare(`
  INSERT INTO events (session_key, org_id, user_id, tenant_slug, name, path, props, ip, user_agent)
  VALUES (@session_key, @org_id, @user_id, @tenant_slug, @name, @path, @props, @ip, @user_agent)
`);
const _eventRecent = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');
const _eventBySession = db.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY id LIMIT 500');
const _eventCounts = db.prepare(`
  SELECT name, COUNT(*) AS n, COUNT(DISTINCT session_key) AS sessions
    FROM events WHERE ts >= ? GROUP BY name ORDER BY n DESC
`);

export const events = {
  record({ sessionKey = null, orgId = null, userId = null, tenantSlug = null,
           name, path = null, props = null, ip = null, userAgent = null }) {
    _eventInsert.run({
      session_key: sessionKey, org_id: orgId, user_id: userId, tenant_slug: tenantSlug,
      name: String(name).slice(0, 120), path: path ? String(path).slice(0, 300) : null,
      props: props ? JSON.stringify(props) : null,
      ip, user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    });
  },
  recent(limit = 100) { return _eventRecent.all(Math.min(limit, 500)); },
  bySession(sessionKey) { return _eventBySession.all(sessionKey); },
  countsSince(epochSec) { return _eventCounts.all(epochSec); },
};

// ── jobs (queue storage — worker logic lives in lib/jobs.js) ─────────────────
const _jobInsert = db.prepare(`
  INSERT INTO jobs (kind, tenant_slug, ref_kind, ref_id, payload, priority, max_attempts, run_after)
  VALUES (@kind, @tenant_slug, @ref_kind, @ref_id, @payload, @priority, @max_attempts, @run_after)
`);
const _jobClaimCandidate = db.prepare(`
  SELECT id FROM jobs
   WHERE status = 'queued' AND kind = ? AND run_after <= strftime('%s','now')
   ORDER BY priority DESC, id ASC LIMIT 1
`);
const _jobMarkRunning = db.prepare(`
  UPDATE jobs SET status = 'running', started_at = strftime('%s','now'), attempts = attempts + 1
   WHERE id = ? AND status = 'queued'
`);
const _jobById = db.prepare('SELECT * FROM jobs WHERE id = ?');
const _jobDone = db.prepare(`
  UPDATE jobs SET status = 'done', finished_at = strftime('%s','now'), result = ?, error = NULL WHERE id = ?
`);
const _jobRetry = db.prepare(`
  UPDATE jobs SET status = 'queued', run_after = ?, error = ? WHERE id = ?
`);
const _jobFail = db.prepare(`
  UPDATE jobs SET status = 'failed', finished_at = strftime('%s','now'), error = ? WHERE id = ?
`);
const _jobRequeueOrphans = db.prepare(`
  UPDATE jobs SET status = 'queued', run_after = 0 WHERE status = 'running'
`);
const _jobSummary = db.prepare('SELECT kind, status, COUNT(*) AS n FROM jobs GROUP BY kind, status');
const _jobHaltSiblings = db.prepare(`
  UPDATE jobs SET status = 'failed', finished_at = strftime('%s','now'), error = ?
   WHERE status = 'queued' AND kind = ? AND tenant_slug IS ?
`);

const _claimTx = db.transaction((kind) => {
  const cand = _jobClaimCandidate.get(kind);
  if (!cand) return null;
  const r = _jobMarkRunning.run(cand.id);
  if (r.changes === 0) return null;
  return _jobById.get(cand.id);
});

export const jobs = {
  enqueue({ kind, tenantSlug = null, refKind = null, refId = null,
            payload = null, priority = 0, maxAttempts = 3, runAfter = 0 }) {
    const r = _jobInsert.run({
      kind, tenant_slug: tenantSlug, ref_kind: refKind,
      ref_id: refId != null ? String(refId) : null,
      payload: payload ? JSON.stringify(payload) : null,
      priority, max_attempts: maxAttempts, run_after: runAfter,
    });
    return r.lastInsertRowid;
  },
  claim(kind) { return _claimTx(kind); },
  byId(id) { return _jobById.get(id) || null; },
  done(id, result = null) { _jobDone.run(result ? JSON.stringify(result) : null, id); },
  retry(id, runAfterEpoch, error) { _jobRetry.run(runAfterEpoch, String(error).slice(0, 2000), id); },
  fail(id, error) { _jobFail.run(String(error).slice(0, 2000), id); },
  requeueOrphans() { return _jobRequeueOrphans.run().changes; },
  summary() { return _jobSummary.all(); },
  // Billing circuit-breaker: kill every queued sibling (same kind + tenant) in one shot.
  haltSiblings({ kind, tenantSlug = null, reason }) {
    return _jobHaltSiblings.run(`halted: ${reason}`, kind, tenantSlug).changes;
  },
};

// ── cost_events ───────────────────────────────────────────────────────────────
const _costInsert = db.prepare(`
  INSERT INTO cost_events (tenant_slug, org_id, provider, model, operation, ref_id,
                           input_tokens, output_tokens, unit_count, usd, meta)
  VALUES (@tenant_slug, @org_id, @provider, @model, @operation, @ref_id,
          @input_tokens, @output_tokens, @unit_count, @usd, @meta)
`);
const _costTotals = db.prepare(`
  SELECT provider, ROUND(SUM(usd), 4) AS usd, COUNT(*) AS calls
    FROM cost_events WHERE ts >= ? GROUP BY provider
`);

export const costEvents = {
  record({ tenantSlug = null, orgId = null, provider, model = null, operation = null,
           refId = null, inputTokens = null, outputTokens = null, unitCount = null,
           usd = 0, meta = null }) {
    _costInsert.run({
      tenant_slug: tenantSlug, org_id: orgId, provider, model, operation,
      ref_id: refId != null ? String(refId) : null,
      input_tokens: inputTokens, output_tokens: outputTokens,
      unit_count: unitCount, usd, meta: meta ? JSON.stringify(meta) : null,
    });
  },
  totalsSince(epochSec) { return _costTotals.all(epochSec); },
};

// ── media_assets ──────────────────────────────────────────────────────────────
const _mediaInsert = db.prepare(`
  INSERT INTO media_assets (tenant_slug, kind, r2_key, content_type, size_bytes, sha256, ref_kind, ref_id)
  VALUES (@tenant_slug, @kind, @r2_key, @content_type, @size_bytes, @sha256, @ref_kind, @ref_id)
`);
const _mediaByTenant = db.prepare(`
  SELECT * FROM media_assets WHERE tenant_slug = ? AND status = 'active' ORDER BY id DESC LIMIT ?
`);
const _mediaSoftDelete = db.prepare("UPDATE media_assets SET status = 'deleted' WHERE id = ?");
const _mediaById = db.prepare('SELECT * FROM media_assets WHERE id = ?');

export const mediaAssets = {
  record({ tenantSlug, kind, r2Key, contentType = null, sizeBytes = null,
           sha256 = null, refKind = null, refId = null }) {
    const r = _mediaInsert.run({
      tenant_slug: tenantSlug, kind, r2_key: r2Key, content_type: contentType,
      size_bytes: sizeBytes, sha256, ref_kind: refKind,
      ref_id: refId != null ? String(refId) : null,
    });
    return r.lastInsertRowid;
  },
  byTenant(slug, limit = 200) { return _mediaByTenant.all(slug, limit); },
  byId(id) { return _mediaById.get(id) || null; },
  softDelete(id) { _mediaSoftDelete.run(id); },
};

// ── tenants ───────────────────────────────────────────────────────────────────
const _tenantInsert = db.prepare(`
  INSERT INTO tenants (slug, business_name, website) VALUES (?, ?, ?)
`);
const _tenantBySlug = db.prepare('SELECT * FROM tenants WHERE slug = ?');
const _tenantList = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC LIMIT ?');
const _tenantSetVertical = db.prepare('UPDATE tenants SET vertical = ? WHERE slug = ?');

export function safeSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export const tenants = {
  // v1 pattern: slugified business name + 4-char suffix → "haus-72y9"
  create({ businessName, website = null, suffix }) {
    const base = safeSlug(businessName).slice(0, 40) || 'brand';
    const slug = `${base}-${suffix}`;
    _tenantInsert.run(slug, businessName, website);
    return _tenantBySlug.get(slug);
  },
  bySlug(slug) { return _tenantBySlug.get(slug) || null; },
  list(limit = 100) { return _tenantList.all(limit); },
  setVertical(slug, vertical) { _tenantSetVertical.run(vertical, slug); },
};

// ── intakes ───────────────────────────────────────────────────────────────────
const _intakeInsert = db.prepare(`
  INSERT INTO intakes (id, tenant_slug, business_name, website) VALUES (?, ?, ?, ?)
`);
const _intakeById = db.prepare('SELECT * FROM intakes WHERE id = ?');
const _intakeList = db.prepare('SELECT * FROM intakes ORDER BY created_at DESC LIMIT ?');
const _intakePatch = db.prepare(`
  UPDATE intakes SET status = COALESCE(@status, status),
                     scrape_key = COALESCE(@scrape_key, scrape_key),
                     llm_calls = COALESCE(@llm_calls, llm_calls),
                     flags = COALESCE(@flags, flags),
                     error = COALESCE(@error, error),
                     value_prop = COALESCE(@value_prop, value_prop),
                     plan = COALESCE(@plan, plan),
                     payment_status = COALESCE(@payment_status, payment_status),
                     paid_at = COALESCE(@paid_at, paid_at),
                     org_id = COALESCE(@org_id, org_id),
                     claimed_user_id = COALESCE(@claimed_user_id, claimed_user_id),
                     updated_at = strftime('%s','now')
   WHERE id = @id
`);

export const intakes = {
  create({ id, tenantSlug, businessName, website }) {
    _intakeInsert.run(id, tenantSlug, businessName, website);
    return _intakeById.get(id);
  },
  byId(id) { return _intakeById.get(id) || null; },
  list(limit = 50) { return _intakeList.all(limit); },
  patch(id, { status = null, scrapeKey = null, llmCalls = null, flags = null, error = null,
              valueProp = null, plan = null, paymentStatus = null, paidAt = null,
              orgId = null, claimedUserId = null } = {}) {
    _intakePatch.run({
      id, status, scrape_key: scrapeKey, llm_calls: llmCalls,
      flags: flags ? JSON.stringify(flags) : null, error,
      value_prop: valueProp ? JSON.stringify(valueProp) : null,
      plan, payment_status: paymentStatus, paid_at: paidAt,
      org_id: orgId, claimed_user_id: claimedUserId,
    });
    return _intakeById.get(id);
  },
};

// ── scrape_sources (per-source honest status flags) ──────────────────────────
const _sourceUpsert = db.prepare(`
  INSERT INTO scrape_sources (intake_id, source, handle, status, note, data)
  VALUES (@intake_id, @source, @handle, @status, @note, @data)
  ON CONFLICT(intake_id, source) DO UPDATE SET
    handle = COALESCE(excluded.handle, handle),
    status = excluded.status,
    note = excluded.note,
    data = COALESCE(excluded.data, data),
    updated_at = strftime('%s','now')
`);
const _sourcesByIntake = db.prepare('SELECT * FROM scrape_sources WHERE intake_id = ? ORDER BY id');

export const scrapeSources = {
  upsert({ intakeId, source, handle = null, status, note = null, data = null }) {
    _sourceUpsert.run({
      intake_id: intakeId, source, handle, status, note,
      data: data ? JSON.stringify(data) : null,
    });
  },
  byIntake(intakeId) { return _sourcesByIntake.all(intakeId); },
};

// ── phantoms / campaigns / pieces (Phase 3 production state) ─────────────────
const _phantomInsert = db.prepare(`
  INSERT INTO phantoms (tenant_slug, intake_id, name, age, persona, appearance_prompt, vibe)
  VALUES (@tenant_slug, @intake_id, @name, @age, @persona, @appearance_prompt, @vibe)
`);
const _phantomsByTenant = db.prepare('SELECT * FROM phantoms WHERE tenant_slug = ? ORDER BY id');
const _phantomById = db.prepare('SELECT * FROM phantoms WHERE id = ?');
const _phantomSetStatus = db.prepare('UPDATE phantoms SET status = ?, ref_image_key = COALESCE(?, ref_image_key) WHERE id = ?');
const _phantomsDeleteByIntake = db.prepare('DELETE FROM phantoms WHERE intake_id = ?');

export const phantoms = {
  cast(row) {
    const r = _phantomInsert.run({
      tenant_slug: row.tenantSlug, intake_id: row.intakeId, name: row.name,
      age: row.age ?? null, persona: row.persona ?? null,
      appearance_prompt: row.appearancePrompt, vibe: row.vibe ?? null,
    });
    return _phantomById.get(r.lastInsertRowid);
  },
  byTenant(slug) { return _phantomsByTenant.all(slug); },
  byId(id) { return _phantomById.get(id) || null; },
  setStatus(id, status, refImageKey = null) { _phantomSetStatus.run(status, refImageKey, id); },
  deleteByIntake(intakeId) { return _phantomsDeleteByIntake.run(intakeId).changes; },
};

const _campaignInsert = db.prepare(`
  INSERT INTO campaigns (tenant_slug, intake_id, title, type, concept, visual_design, moment, product_refs)
  VALUES (@tenant_slug, @intake_id, @title, @type, @concept, @visual_design, @moment, @product_refs)
`);
const _campaignsByIntake = db.prepare('SELECT * FROM campaigns WHERE intake_id = ? ORDER BY id');
const _campaignById = db.prepare('SELECT * FROM campaigns WHERE id = ?');
const _campaignsDeleteByIntake = db.prepare('DELETE FROM campaigns WHERE intake_id = ?');

export const campaigns = {
  create(row) {
    const r = _campaignInsert.run({
      tenant_slug: row.tenantSlug, intake_id: row.intakeId, title: row.title, type: row.type,
      concept: row.concept, visual_design: row.visualDesign, moment: row.moment ?? null,
      product_refs: row.productRefs ? JSON.stringify(row.productRefs) : null,
    });
    return _campaignById.get(r.lastInsertRowid);
  },
  byIntake(intakeId) { return _campaignsByIntake.all(intakeId); },
  byId(id) { return _campaignById.get(id) || null; },
  deleteByIntake(intakeId) { return _campaignsDeleteByIntake.run(intakeId).changes; },
};

const _pieceInsert = db.prepare(`
  INSERT INTO pieces (tenant_slug, intake_id, campaign_id, phantom_id, kind, pillar, scheduled_date, brief)
  VALUES (@tenant_slug, @intake_id, @campaign_id, @phantom_id, @kind, @pillar, @scheduled_date, @brief)
`);
const _piecesByIntake = db.prepare('SELECT * FROM pieces WHERE intake_id = ? ORDER BY scheduled_date, id');
const _pieceById = db.prepare('SELECT * FROM pieces WHERE id = ?');
const _pieceSetStatus = db.prepare('UPDATE pieces SET status = ? WHERE id = ?');
const _piecesCountByIntake = db.prepare('SELECT kind, COUNT(*) AS n FROM pieces WHERE intake_id = ? GROUP BY kind');
const _piecesCalendar = db.prepare(`
  SELECT scheduled_date AS date,
         SUM(CASE WHEN kind = 'reel' THEN 1 ELSE 0 END) AS reels,
         SUM(CASE WHEN kind = 'post' THEN 1 ELSE 0 END) AS posts
    FROM pieces WHERE intake_id = ? GROUP BY scheduled_date ORDER BY scheduled_date
`);
const _piecesDeleteByIntake = db.prepare('DELETE FROM pieces WHERE intake_id = ?');
const _pieceInsertMany = db.transaction((rows) => { for (const r of rows) _pieceInsert.run(r); });

export const pieces = {
  createMany(rows) {
    _pieceInsertMany(rows.map((row) => ({
      tenant_slug: row.tenantSlug, intake_id: row.intakeId, campaign_id: row.campaignId,
      phantom_id: row.phantomId ?? null, kind: row.kind, pillar: row.pillar ?? null,
      scheduled_date: row.scheduledDate, brief: JSON.stringify(row.brief),
    })));
  },
  byIntake(intakeId) { return _piecesByIntake.all(intakeId); },
  byId(id) { return _pieceById.get(id) || null; },
  setStatus(id, status) { _pieceSetStatus.run(status, id); },
  countByIntake(intakeId) { return _piecesCountByIntake.all(intakeId); },
  calendar(intakeId) { return _piecesCalendar.all(intakeId); },
  deleteByIntake(intakeId) { return _piecesDeleteByIntake.run(intakeId).changes; },
};

// ── audio_tracks ──────────────────────────────────────────────────────────────
const _trackInsert = db.prepare(`
  INSERT INTO audio_tracks (title, artist, source, license_note, r2_key, duration_sec, bpm, vibe_tags)
  VALUES (@title, @artist, @source, @license_note, @r2_key, @duration_sec, @bpm, @vibe_tags)
`);
const _trackList = db.prepare('SELECT * FROM audio_tracks ORDER BY id DESC');

export const audioTracks = {
  add({ title, artist = null, source = 'operator_upload', licenseNote = null,
        r2Key, durationSec = null, bpm = null, vibeTags = null }) {
    const r = _trackInsert.run({
      title, artist, source, license_note: licenseNote, r2_key: r2Key,
      duration_sec: durationSec, bpm, vibe_tags: vibeTags ? JSON.stringify(vibeTags) : null,
    });
    return r.lastInsertRowid;
  },
  list() { return _trackList.all(); },
};

export default db;
