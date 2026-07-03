-- 007_deploy_tracker.sql — Phase 7: social connections, deployments, metrics, reports.
--
-- Deploy model (Ayrshare Business): one Ayrshare "profile" per tenant
-- (Profile-Key); the customer links IG/TikTok/YT through Ayrshare's hosted
-- connect page. Publishing is calendar-driven: we submit once with
-- scheduleDate = piece.scheduled_date and Ayrshare fires it — no cron needed.
-- The month-end tracker snapshots metrics → report → learnings + upgrade offer
-- (the BPMN's compounding loop).

CREATE TABLE IF NOT EXISTS social_connections (
  tenant_slug          TEXT PRIMARY KEY REFERENCES tenants(slug),
  ayrshare_profile_key TEXT NOT NULL,
  platforms            TEXT,                               -- JSON: linked platforms (refreshed from Ayrshare)
  status               TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','linked')),
  connected_at         INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS deployments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug      TEXT NOT NULL,
  intake_id        TEXT,
  piece_id         INTEGER NOT NULL REFERENCES pieces(id),
  platforms        TEXT NOT NULL,                          -- JSON array
  scheduled_at     TEXT,                                   -- ISO date the calendar wants
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','published','failed','skipped')),
  ayrshare_post_id TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  published_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_slug, id);
CREATE INDEX IF NOT EXISTS idx_deployments_piece ON deployments(piece_id);

CREATE TABLE IF NOT EXISTS metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug   TEXT NOT NULL,
  deployment_id INTEGER REFERENCES deployments(id),
  piece_id      INTEGER,
  platform      TEXT,
  captured_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  views         INTEGER, likes INTEGER, comments INTEGER, shares INTEGER,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_tenant ON metrics(tenant_slug, id);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT NOT NULL,
  intake_id   TEXT,
  period      TEXT NOT NULL,                               -- YYYY-MM
  summary     TEXT NOT NULL,                               -- JSON (stats, winners, performance_rules, upsell)
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (tenant_slug, period)
);
