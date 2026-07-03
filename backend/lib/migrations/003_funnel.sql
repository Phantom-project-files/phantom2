-- 003_funnel.sql — Phase 2: value prop, plan selection, payment state, purchases.
--
-- Funnel order (BPMN): intake → scrape → VALUE PROP (3× 16:9 frames) → pricing
-- plan → OAuth (Google) → Stripe payment → generation unlock. The entitlement
-- check downstream is: payment_status ∈ ('paid','admin_override').

ALTER TABLE intakes ADD COLUMN value_prop TEXT;                    -- JSON: { frames:[{eyebrow,headline,body,stat}] }
ALTER TABLE intakes ADD COLUMN plan TEXT;                          -- standard | premium | ultra | overkill
ALTER TABLE intakes ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';  -- unpaid | paid | admin_override
ALTER TABLE intakes ADD COLUMN paid_at INTEGER;
ALTER TABLE intakes ADD COLUMN org_id INTEGER REFERENCES orgs(id); -- claimed at OAuth
ALTER TABLE intakes ADD COLUMN claimed_user_id INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS purchases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id         TEXT NOT NULL REFERENCES intakes(id),
  tenant_slug       TEXT NOT NULL,
  org_id            INTEGER,
  plan              TEXT NOT NULL,
  amount_usd        INTEGER NOT NULL,                              -- whole dollars
  recurring         INTEGER NOT NULL DEFAULT 0,                    -- 0 one-time | 1 monthly
  stripe_session_id TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','paid','failed','mock_paid')),
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  paid_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_purchases_intake ON purchases(intake_id);
