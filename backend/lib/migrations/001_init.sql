-- 001_init.sql — Phantom 2.0 foundation schema (Phase 0).
--
-- Carried from v1 (proven, ported auth code depends on these exact shapes):
--   admins, admin_sessions, logs
-- New for 2.0 (BPMN):
--   orgs/users/user_sessions  — OAuth customers (Phase 2 fleshes out Google fields)
--   events                    — first-party user-journey stream (also triggers agent-email)
--   jobs                      — SQLite-backed work queue (the v1 stampede/stranding fix)
--   cost_events               — per-provider spend ledger
--   media_assets              — R2-backed artifact registry
--   audio_tracks              — operator-supplied music library for the beat-cut editor
--
-- Tenants / intake / campaigns / pieces arrive with Phases 1-3 migrations.

-- ── operators ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  password_hash   TEXT,                                    -- NULL until invite is accepted
  role            TEXT NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('owner','admin','viewer')),
  invite_token    TEXT UNIQUE,
  invite_expires  INTEGER,                                 -- epoch seconds
  invited_by      INTEGER REFERENCES admins(id),
  status          TEXT NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('invited','active','disabled')),
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  accepted_at     INTEGER,
  last_login_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admins_invite_token ON admins(invite_token);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           TEXT PRIMARY KEY,                           -- 43-char base64url (32 random bytes)
  admin_id     INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp   ON admin_sessions(expires_at);

-- ── customers (Phase 2 wires Google OAuth onto these) ────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER REFERENCES orgs(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  google_sub    TEXT UNIQUE,                               -- Google OAuth subject
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- ── user-journey events (first-party analytics + agent-email trigger stream) ─
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  session_key TEXT,                                        -- anonymous ph_sid cookie
  org_id      INTEGER,
  user_id     INTEGER,
  tenant_slug TEXT,
  name        TEXT NOT NULL,                               -- e.g. page.landing, intake.start, funnel.paid
  path        TEXT,
  props       TEXT,                                        -- JSON blob
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_name    ON events(name, id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_key, id);
CREATE INDEX IF NOT EXISTS idx_events_tenant  ON events(tenant_slug, id);

-- ── job queue (concurrency-capped worker; survives restarts) ─────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                              -- llm | fal_image | fal_video | chrome | scrape | ...
  tenant_slug  TEXT,
  ref_kind     TEXT,                                       -- piece | phantom | intake | ...
  ref_id       TEXT,
  payload      TEXT,                                       -- JSON
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed')),
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    INTEGER NOT NULL DEFAULT 0,                 -- epoch seconds (retry backoff)
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT,
  result       TEXT                                        -- JSON
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim  ON jobs(status, kind, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_slug, status);

-- ── spend ledger ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  tenant_slug   TEXT,
  org_id        INTEGER,
  provider      TEXT NOT NULL,                             -- anthropic | claude_code | fal | stripe | ...
  model         TEXT,
  operation     TEXT,                                      -- scrape.extract | script.campaigns | reel.video | ...
  ref_id        TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  unit_count    REAL,                                      -- e.g. video seconds, images
  usd           REAL NOT NULL DEFAULT 0,                   -- estimate for dashboards, not billing-grade
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_tenant ON cost_events(tenant_slug, id);
CREATE INDEX IF NOT EXISTS idx_cost_provider ON cost_events(provider, id);

-- ── media registry (R2-first: every artifact lands here at creation) ─────────
CREATE TABLE IF NOT EXISTS media_assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug  TEXT NOT NULL,
  kind         TEXT NOT NULL,                              -- phantom | reel | post | product | brand | shot | scratch
  r2_key       TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes   INTEGER,
  sha256       TEXT,
  ref_kind     TEXT,
  ref_id       TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','deleted')),
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_media_tenant ON media_assets(tenant_slug, kind, id);

-- ── music library (operator-supplied, rights-cleared; beat-cut editor input) ─
CREATE TABLE IF NOT EXISTS audio_tracks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  artist       TEXT,
  source       TEXT NOT NULL DEFAULT 'operator_upload',    -- provenance; uploads are operator-attested
  license_note TEXT,                                       -- where the rights come from
  r2_key       TEXT NOT NULL UNIQUE,
  duration_sec REAL,
  bpm          REAL,
  vibe_tags    TEXT,                                       -- JSON array: ["energetic","luxury",...]
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ── structured system logs (v1 shape — lib/logs.js depends on it) ────────────
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  level       TEXT NOT NULL DEFAULT 'info',
  tenant_slug TEXT,
  org_id      INTEGER,
  provider    TEXT,
  event       TEXT NOT NULL,
  ref_id      TEXT,
  message     TEXT,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_id ON logs(id);
CREATE INDEX IF NOT EXISTS idx_logs_tenant_id ON logs(tenant_slug, id);
