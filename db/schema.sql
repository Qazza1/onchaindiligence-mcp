-- D2.2 durable receipt storage.
--
-- Two small tables. Deliberately no receipt-listing/enumeration support: the
-- only read path the product exposes is exact lookup by receipt_id (the
-- resolver, GET /receipts/:receiptId) and exact lookup by capability hash
-- (finalization). Idempotent (CREATE ... IF NOT EXISTS) so this file can be
-- re-run safely; it never ALTERs existing columns, so re-running after a
-- schema change requires a new migration file, not an edit to this one.
--
-- Run with: npm run db:migrate (scripts/migrate.ts), against DATABASE_URL.

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id      TEXT PRIMARY KEY,
  receipt_digest  TEXT NOT NULL,
  receipt_type    TEXT NOT NULL CHECK (receipt_type IN ('ACTION', 'PREFLIGHT', 'COMMERCE')),
  envelope_json   JSONB NOT NULL,
  is_public       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- finalization looks up the bound PREFLIGHT receipt by id; this index keeps
-- that lookup and the append-only idempotent-write check both fast.
CREATE INDEX IF NOT EXISTS receipts_type_idx ON receipts (receipt_type);

CREATE TABLE IF NOT EXISTS finalization_capabilities (
  capability_hash             TEXT PRIMARY KEY,          -- sha256(raw token), hex. Raw token is NEVER stored.
  preflight_receipt_id        TEXT NOT NULL REFERENCES receipts (receipt_id),
  preflight_receipt_digest    TEXT NOT NULL,
  expires_at                  TIMESTAMPTZ NOT NULL,
  used_at                     TIMESTAMPTZ,                -- NULL until consumed
  consumed_transaction_hash   TEXT,                       -- set atomically with used_at
  commerce_receipt_id         TEXT REFERENCES receipts (receipt_id), -- set atomically with used_at
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finalization_capabilities_preflight_idx
  ON finalization_capabilities (preflight_receipt_id);

-- The caller's publication.commerce preference (D2.2), captured at mint time
-- so finalization knows whether to publish the resulting Commerce Receipt
-- without needing it signed into the receipt content itself. Added via
-- ALTER rather than editing the CREATE TABLE above, per this file's own
-- migration discipline: existing statements are never rewritten in place.
ALTER TABLE finalization_capabilities
  ADD COLUMN IF NOT EXISTS publish_commerce BOOLEAN NOT NULL DEFAULT FALSE;
