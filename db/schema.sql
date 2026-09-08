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

-- D2.2B2: idempotency for scripts/reconcile-commerce-receipt.ts. A prior
-- Commerce Receipt whose original chain observation could not obtain a
-- definitive result (RPC transiently unavailable) is NEVER deleted or
-- rewritten -- this table records, at most once per prior receipt, the id
-- of the LATER immutable Commerce Receipt that independently re-observed
-- the same transaction. PRIMARY KEY on prior_receipt_id enforces "at most
-- one reconciliation per prior receipt" at the database level, not just in
-- application code.
CREATE TABLE IF NOT EXISTS receipt_reconciliations (
  prior_receipt_id       TEXT PRIMARY KEY REFERENCES receipts (receipt_id),
  reconciled_receipt_id  TEXT NOT NULL UNIQUE REFERENCES receipts (receipt_id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- D2.4 — ACTION-BOUND + RESUMABLE COMMERCE.
--
-- Four additive tables carrying one durable operation (one intended
-- merchant payment) through to resumable recovery, without touching any
-- table above. Nothing here changes how `receipts` or
-- `finalization_capabilities` behave -- the legacy /x402/preflight-payment
-- and /receipts/finalize routes are byte-for-byte unchanged and keep using
-- only the tables above.
-- ---------------------------------------------------------------------

-- ONE durable operation = one intended merchant payment. `operation_id` is
-- random and opaque (carries no invoice/customer/private semantic data);
-- `recovery_credential_hash` is the ONLY thing that authorizes reading or
-- resuming this operation's private state -- the operation_id alone grants
-- nothing (see src/operation.ts). The four state columns are orthogonal
-- (Section 11): no single enum conflates "policy decision" with "did the
-- money move".
CREATE TABLE IF NOT EXISTS commerce_operations (
  operation_id              TEXT PRIMARY KEY,
  recovery_credential_hash  TEXT NOT NULL,
  preflight_state           TEXT NOT NULL DEFAULT 'not_started'
    CHECK (preflight_state IN ('not_started', 'in_progress', 'completed')),
  execution_state           TEXT NOT NULL DEFAULT 'not_submitted'
    CHECK (execution_state IN ('not_submitted', 'prepared', 'submission_ambiguous', 'submitted', 'outcome_unknown', 'transaction_known', 'manual_recovery_required')),
  observation_state         TEXT NOT NULL DEFAULT 'none'
    CHECK (observation_state IN ('none', 'pending', 'confirmed', 'contradicted')),
  receipt_state             TEXT NOT NULL DEFAULT 'none'
    CHECK (receipt_state IN ('none', 'preflight_only', 'commerce_issued')),
  preflight_receipt_id      TEXT REFERENCES receipts (receipt_id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Authenticated step idempotency journal (Section 3). Primary key on
-- (operation_id, step_key) makes "claim this step" an atomic
-- INSERT ... ON CONFLICT DO NOTHING -- exactly the pattern already used by
-- putReceipt() above, just generalized to any named step. `input_digest`
-- pins "same step + same input"; a claim against an existing row with a
-- DIFFERENT digest is an explicit conflict (see src/lifecycleSteps.ts),
-- never a silent overwrite. `capability_token` exists ONLY for the
-- 'preflight' step and is the one deliberate, narrow, authenticated
-- exception to "never store a raw capability token" (capability.ts) --
-- see src/lifecycleSteps.ts's header for the full justification.
CREATE TABLE IF NOT EXISTS lifecycle_steps (
  operation_id            TEXT NOT NULL REFERENCES commerce_operations (operation_id),
  step_key                TEXT NOT NULL,
  input_digest            TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('claimed', 'paid', 'completed')),
  frozen_input_json       JSONB NOT NULL,
  capability_token        TEXT,
  capability_expires_at   TIMESTAMPTZ,
  result_json             JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, step_key)
);

-- Durable execution/payment binding (Section 6), created BEFORE any
-- potentially mutating submission. `client_submission_key` is chosen by the
-- executor/caller and is what makes binding creation itself idempotent: a
-- stale worker retrying with the SAME key can never mint a second binding
-- for what it believes is the same submission attempt (UNIQUE below +
-- INSERT ... ON CONFLICT DO NOTHING, same pattern as everywhere else in
-- this file). `expected_payer` is the frozen commitment the PAYMENT_IDENTITY_LINKED
-- claim level checks the observed on-chain authorization against.
CREATE TABLE IF NOT EXISTS execution_bindings (
  execution_request_id     TEXT PRIMARY KEY,
  operation_id             TEXT NOT NULL REFERENCES commerce_operations (operation_id),
  client_submission_key    TEXT NOT NULL,
  executor_identity        TEXT NOT NULL,
  executor_version         TEXT NOT NULL,
  recovery_capability_class TEXT NOT NULL CHECK (recovery_capability_class IN ('provider-idempotent', 'stable-payment-identity', 'none')),
  frozen_preflight_receipt_id     TEXT NOT NULL REFERENCES receipts (receipt_id),
  frozen_preflight_receipt_digest TEXT NOT NULL,
  expected_payer           TEXT,
  provider_reference       TEXT,
  submission_state         TEXT NOT NULL DEFAULT 'not_submitted'
    CHECK (submission_state IN ('not_submitted', 'prepared', 'submission_ambiguous', 'submitted', 'outcome_unknown', 'transaction_known', 'manual_recovery_required')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_id, client_submission_key)
);

-- Append-only exact chain-event observations (Section 8/10). Natural key is
-- the exact selected event -- network + block_hash + transaction_hash +
-- log_index -- NOT a value-based heuristic like "largest transfer", so a
-- reorg/re-inclusion or a later corrective re-observation always produces a
-- genuinely NEW row rather than colliding with or overwriting a prior one.
-- Never UPDATEd or DELETEd; the unique constraint below is what makes a
-- retried identical observation idempotent rather than duplicated.
CREATE TABLE IF NOT EXISTS commerce_observations (
  observation_id            TEXT PRIMARY KEY,
  operation_id              TEXT NOT NULL REFERENCES commerce_operations (operation_id),
  network                   TEXT NOT NULL,
  block_number              TEXT NOT NULL,
  block_hash                TEXT NOT NULL,
  transaction_hash          TEXT NOT NULL,
  log_index                 INTEGER NOT NULL,
  observed_payer            TEXT,
  observed_recipient        TEXT,
  observed_amount_atomic    TEXT,
  token_contract             TEXT NOT NULL,
  payment_authorizer        TEXT,
  payment_authorization_nonce TEXT,
  finality_policy           TEXT NOT NULL,
  finality_state            TEXT NOT NULL,
  chain_head_used_json      JSONB,
  binding_strength          TEXT NOT NULL CHECK (binding_strength IN ('TRANSFER_MATCH_ONLY', 'EXECUTOR_CORRELATED', 'PAYMENT_IDENTITY_LINKED')),
  bundle_digest             TEXT,
  observed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, block_hash, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS commerce_observations_operation_idx ON commerce_observations (operation_id);
CREATE INDEX IF NOT EXISTS execution_bindings_operation_idx ON execution_bindings (operation_id);

-- D2.7A -- authenticated private operation history + recovery center.
--
-- `accounts` is a NEW, separate identity concept from everything above --
-- and from the UNRELATED "operator" in the operator/ directory (the D2.2B
-- manual payment console UI). An operation's own `recovery_credential`
-- proves "I hold the secret for THIS one operation" and grants no
-- visibility into any other operation. An account's `api_key` proves "I am
-- the same party that created operation(s) tagged with my account_id" and
-- is what a private history/list view authenticates against. Same
-- discipline as recovery_credential/finalization capabilities: only the
-- SHA-256 hash of the raw key is ever persisted.
CREATE TABLE IF NOT EXISTS accounts (
  account_id      TEXT PRIMARY KEY,
  api_key_hash    TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable and additive: existing/anonymous operations (including every
-- D2.6 reference-harness operation) keep owner_id NULL and simply never
-- appear in any account's private history -- this is correct, not a gap,
-- since they were never associated with an account to begin with.
ALTER TABLE commerce_operations ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES accounts (account_id);
CREATE INDEX IF NOT EXISTS commerce_operations_owner_idx ON commerce_operations (owner_id, created_at DESC) WHERE owner_id IS NOT NULL;

-- D3.1A — an account's bookmark relationship to an existing public receipt.
-- The signed envelope remains in the public receipt store; this table stores
-- no receipt body and makes no claim about verification or outcome.
CREATE TABLE IF NOT EXISTS saved_receipts (
  account_id TEXT NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS saved_receipts_account_idx ON saved_receipts (account_id, saved_at DESC);

-- Lets operation-detail lookups find the eventual Commerce receipt id from
-- the operation's own (already-known) preflight_receipt_id, without a new
-- column on commerce_operations itself -- see src/db.ts's
-- getCommerceReceiptIdForPreflightReceipt().
CREATE INDEX IF NOT EXISTS finalization_capabilities_preflight_receipt_idx ON finalization_capabilities (preflight_receipt_id);

-- D2.7B -- account-scoped outbound webhooks for operation lifecycle events.
--
-- `signing_secret` is stored in PLAIN TEXT deliberately -- a different
-- discipline from recovery_credential/api_key_hash above. Those are
-- credentials callers present TO us (so only a hash is ever needed, to
-- compare). A webhook signing secret is the reverse: WE use it to prove
-- OUR authenticity to the customer's endpoint on every delivery, so the
-- raw value must remain usable server-side, exactly like any third-party
-- API secret a backend stores to call out with. It is still never returned
-- by GET /me/webhooks -- only once, at creation.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  webhook_id      TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts (account_id),
  url             TEXT NOT NULL,
  signing_secret  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_account_idx ON webhook_endpoints (account_id);

-- One row per MEANINGFUL lifecycle transition, not per DB write. UNIQUE
-- (operation_id, type, dedupe_key) is what makes emitting an event
-- idempotent: re-running the same state transition (e.g. a retried
-- request resuming the same operation) hits this constraint and enqueues
-- no new event/deliveries -- see src/webhookEvents.ts.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts (account_id),
  operation_id    TEXT NOT NULL REFERENCES commerce_operations (operation_id),
  type            TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  data_json       JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_id, type, dedupe_key)
);
CREATE INDEX IF NOT EXISTS webhook_events_account_idx ON webhook_events (account_id, created_at DESC);

-- One row per (event, endpoint) delivery attempt lineage. A delivery
-- retry updates the SAME row (bumping attempt_count/next_attempt_at) --
-- it never creates a second event or a second delivery row for the same
-- (event_id, webhook_id) pair.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id       TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES webhook_events (event_id),
  webhook_id        TEXT NOT NULL REFERENCES webhook_endpoints (webhook_id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_http_status  INTEGER,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  UNIQUE (event_id, webhook_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at) WHERE status = 'pending';

-- D2.9A -- merchant/response evidence. Answers "the payment happened, what
-- did the merchant actually return?" WITHOUT pretending OCD independently
-- observed it: `source` is a fixed enum currently containing only
-- CALLER_REPORTED, and there is no code path that lets a caller choose or
-- upgrade it (see src/merchantEvidence.ts) -- OCD would only ever write a
-- different source value itself, if it someday genuinely observes a
-- merchant response independently, which this version does not attempt.
--
-- The raw response body is deliberately NEVER stored -- only a SHA-256
-- digest, byte length, content type, and HTTP status. `evidence_id` is
-- content-derived (contentId() over the submitted fields, same convention
-- as commerce_observations.observation_id) so a retried, byte-identical
-- submission is idempotent by construction; a genuinely different
-- response produces a genuinely different id and a NEW row -- this table
-- is append-only, exactly like commerce_observations.
CREATE TABLE IF NOT EXISTS merchant_evidence (
  evidence_id             TEXT PRIMARY KEY,
  operation_id            TEXT NOT NULL REFERENCES commerce_operations (operation_id),
  source                  TEXT NOT NULL DEFAULT 'CALLER_REPORTED' CHECK (source IN ('CALLER_REPORTED')),
  resource_url            TEXT NOT NULL,
  http_status             INTEGER NOT NULL,
  content_type            TEXT,
  response_body_digest    TEXT NOT NULL,
  response_bytes          INTEGER,
  execution_request_id    TEXT REFERENCES execution_bindings (execution_request_id),
  provider_reference      TEXT,
  transaction_hash        TEXT,
  -- Small allowlist only (etag/content-length/x-request-id) -- see
  -- src/merchantEvidence.ts's ALLOWED_RESPONSE_HEADERS. Never raw headers.
  response_headers_json   JSONB,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_evidence_operation_idx ON merchant_evidence (operation_id, recorded_at ASC);
