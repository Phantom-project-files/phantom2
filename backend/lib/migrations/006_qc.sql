-- 006_qc.sql — Phase 6: the QC training signal.
--
-- qc_verdicts is APPEND-ONLY (v1-proven): every approve/reject lands here with
-- reasons — this is the store lib/qc-learnings.js rolls into <brand_learnings>
-- for the next script-gen batch, so content quality compounds per brand.
-- The regen cap (operator spec: max 3) lives on pieces.regen_count.

CREATE TABLE IF NOT EXISTS qc_verdicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT NOT NULL,
  intake_id   TEXT,
  piece_id    INTEGER,                                     -- NULL for phantom verdicts
  phantom_id  INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('reel','post','phantom')),
  verdict     TEXT NOT NULL CHECK (verdict IN ('approve','reject')),
  reason_text TEXT,
  reason_tags TEXT,                                        -- JSON: face_quality|caption|brand_tone|off_pillar|product|motion|audio
  actor       TEXT NOT NULL DEFAULT 'operator',            -- operator | customer
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_qc_verdicts_intake ON qc_verdicts(intake_id, id);
CREATE INDEX IF NOT EXISTS idx_qc_verdicts_tenant ON qc_verdicts(tenant_slug, id);

-- LLM-summarized learnings, cached by verdict count (re-summarize only when new
-- verdicts landed — the v1 volume-cache pattern moved into SQLite).
CREATE TABLE IF NOT EXISTS qc_learnings_cache (
  tenant_slug   TEXT PRIMARY KEY,
  verdict_count INTEGER NOT NULL,
  bullets       TEXT NOT NULL,                             -- JSON array of imperative rules
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
