-- 002_intake_scrape.sql — Phase 1: tenants, intakes, per-source scrape status.
--
-- An intake = one "Get started" run (business name + website — the BPMN's two
-- yellow diamonds). A tenant row is minted at intake time (v1 pattern:
-- slugified name + nanoid suffix) so every artifact has a tenant-scoped R2 key
-- from the first byte; org claiming happens at OAuth (Phase 2).
--
-- scrape_sources is the operator-facing flag system: one row per source the
-- scraper attempted, with an honest status — `blocked_needs_apify` tells the
-- operator exactly which Apify actor to buy instead of silently returning nothing.

CREATE TABLE IF NOT EXISTS tenants (
  slug          TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  website       TEXT,
  org_id        INTEGER REFERENCES orgs(id),
  status        TEXT NOT NULL DEFAULT 'intake'
                CHECK (status IN ('intake','active','archived')),
  vertical      TEXT,                                      -- apparel | music_artist | other (scraper classifies)
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS intakes (
  id            TEXT PRIMARY KEY,                          -- nanoid
  tenant_slug   TEXT NOT NULL REFERENCES tenants(slug),
  business_name TEXT NOT NULL,
  website       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created'
                CHECK (status IN ('created','scraping','scraped','partial','failed')),
  scrape_key    TEXT,                                      -- R2 key of assembled scrape.json
  llm_calls     INTEGER NOT NULL DEFAULT 0,                -- token-budget gate counter
  flags         TEXT,                                      -- JSON array of operator-facing notes
  error         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_intakes_tenant ON intakes(tenant_slug, id);

CREATE TABLE IF NOT EXISTS scrape_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id   TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,                               -- website | instagram | tiktok | twitter | linkedin | youtube | facebook | wikipedia
  handle      TEXT,                                        -- discovered handle/url for the source
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','scraped','partial','blocked_needs_apify','not_found','skipped','failed')),
  note        TEXT,                                        -- operator-facing detail ("login wall", "JS shell", …)
  data        TEXT,                                        -- JSON: whatever the source yielded
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (intake_id, source)
);
CREATE INDEX IF NOT EXISTS idx_scrape_sources_intake ON scrape_sources(intake_id);
