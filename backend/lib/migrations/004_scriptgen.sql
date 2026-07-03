-- 004_scriptgen.sql — Phase 3: phantoms, campaigns, pieces (+ the deployment calendar).
--
-- Script-gen (BPMN sheet) turns a paid intake into production state:
--   phantoms  — the 6 UGC characters cast from the scraped target-market personas
--   campaigns — 5–30 idea clusters; each holds ONE shared visual design
--   pieces    — every reel/post to produce: campaign + phantom + scheduled_date +
--               a full production brief (the contract Agent-imageGen/videogen execute)
--
-- The calendar is not a separate table: it IS pieces.scheduled_date (Premium =
-- exactly 1 reel + 1 post per day; the console renders GROUP BY date).

CREATE TABLE IF NOT EXISTS phantoms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug       TEXT NOT NULL REFERENCES tenants(slug),
  intake_id         TEXT REFERENCES intakes(id),
  name              TEXT NOT NULL,
  age               INTEGER,
  persona           TEXT,                                  -- which target persona they embody
  appearance_prompt TEXT NOT NULL,                         -- locked visual description (consistency across gens)
  vibe              TEXT,                                  -- voice/energy notes for scripts
  ref_image_key     TEXT,                                  -- R2 key of the reference face (Phase 4)
  status            TEXT NOT NULL DEFAULT 'cast'
                    CHECK (status IN ('cast','rendering','ready','rejected')),
  synthetic         INTEGER NOT NULL DEFAULT 1,            -- always 1 — AI-generated identity stamp
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_phantoms_tenant ON phantoms(tenant_slug, id);

CREATE TABLE IF NOT EXISTS campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug   TEXT NOT NULL REFERENCES tenants(slug),
  intake_id     TEXT REFERENCES intakes(id),
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,                             -- product | weather | fifa | world_event | business_event | brand | educational | lifestyle
  concept       TEXT NOT NULL,                             -- the idea in 1-3 sentences
  visual_design TEXT NOT NULL,                             -- the SHARED look: setting/palette/mood/lighting
  moment        TEXT,                                      -- the real-world moment it rides (if any)
  product_refs  TEXT,                                      -- JSON array of product names featured
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','in_production','complete')),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_slug, id);

CREATE TABLE IF NOT EXISTS pieces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug    TEXT NOT NULL REFERENCES tenants(slug),
  intake_id      TEXT REFERENCES intakes(id),
  campaign_id    INTEGER NOT NULL REFERENCES campaigns(id),
  phantom_id     INTEGER REFERENCES phantoms(id),
  kind           TEXT NOT NULL CHECK (kind IN ('reel','post')),
  pillar         TEXT,                                     -- posts only: product | brand | educational | lifestyle
  scheduled_date TEXT NOT NULL,                            -- YYYY-MM-DD deployment day
  brief          TEXT NOT NULL,                            -- JSON production contract (see lib/scriptgen)
  status         TEXT NOT NULL DEFAULT 'briefed'
                 CHECK (status IN ('briefed','rendering','ready','failed','qc_pending','approved','rejected')),
  regen_count    INTEGER NOT NULL DEFAULT 0,               -- QC cap: max 3 (Phase 6)
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pieces_tenant_date ON pieces(tenant_slug, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_pieces_campaign ON pieces(campaign_id);
CREATE INDEX IF NOT EXISTS idx_pieces_status ON pieces(tenant_slug, status);
