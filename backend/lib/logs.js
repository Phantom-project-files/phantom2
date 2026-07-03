// 0.1.0: structured system logs → DB (admin Logs panel). Fire-and-forget: logging must
// never break a request, so logEvent swallows errors. Tenant-tagged for global or
// company-scoped views.

import { db } from './db.js';

const _insert = db.prepare(`
  INSERT INTO logs (level, tenant_slug, org_id, provider, event, ref_id, message, meta)
  VALUES (@level, @tenant_slug, @org_id, @provider, @event, @ref_id, @message, @meta)
`);
const _insertMany = db.transaction((rows) => { for (const r of rows) _insert.run(r); });
const _recent = db.prepare(`
  SELECT id, ts, level, tenant_slug, org_id, provider, event, ref_id, message, meta
  FROM logs ORDER BY id DESC LIMIT ?
`);
const _recentByTenant = db.prepare(`
  SELECT id, ts, level, tenant_slug, org_id, provider, event, ref_id, message, meta
  FROM logs WHERE tenant_slug = ? ORDER BY id DESC LIMIT ?
`);

// Audit writes are decoupled from the request path: logEvent buffers the row and
// schedules a single batched, transactional drain on the next tick (setImmediate),
// so the SQLite write happens AFTER the response is sent and many events coalesce
// into one transaction. Same fire-and-forget contract — it never throws.
let _pending = [];
let _scheduled = false;

function _drain() {
  _scheduled = false;
  if (!_pending.length) return;
  const batch = _pending;
  _pending = [];
  try { _insertMany(batch); } catch { /* best-effort — never throw from a logger */ }
}

function _schedule() {
  if (_scheduled) return;
  _scheduled = true;
  setImmediate(_drain);
}

export function logEvent({
  level = 'info', tenantSlug = null, orgId = null, provider = null,
  event, refId = null, message = null, meta = null,
} = {}) {
  try {
    _pending.push({
      level,
      tenant_slug: tenantSlug,
      org_id: orgId,
      provider,
      event: event || 'event',
      ref_id: refId ? String(refId).slice(0, 200) : null,
      message: message != null ? String(message).slice(0, 1000) : null,
      meta: meta ? JSON.stringify(meta) : null,
    });
    _schedule();
  } catch { /* best-effort — never throw from a logger */ }
}

// Flush buffered rows synchronously on exit so a short-lived script (e.g. backfills,
// generate-all-*) doesn't drop its last audit rows.
process.on('beforeExit', _drain);

// Force a synchronous flush of any buffered audit rows (used by tests/verification
// that read logs immediately after writing).
export function flushLogs() { _drain(); }

function _parse(rows) {
  for (const r of rows) {
    if (r.meta) { try { r.meta = JSON.parse(r.meta); } catch { /* keep raw */ } }
  }
  return rows;
}

export function recentLogs({ tenant = null, limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return _parse(tenant ? _recentByTenant.all(tenant, lim) : _recent.all(lim));
}
