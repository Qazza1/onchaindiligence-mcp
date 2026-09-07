# Data Handling — current pilot environment

What OCD actually stores and doesn't, stated from the current
implementation (`db/schema.sql`, `src/*.ts`) — not a formal privacy
policy, and not a promise about future behavior. **No automatic
retention/deletion period exists for the records below unless explicitly
stated otherwise.** Where that's true, it's stated plainly rather than
invented.

## Operation metadata

`commerce_operations` (operation id, lifecycle state, timestamps, and —
only if you sent an account `Authorization` header when creating it — the
owning account id) is retained indefinitely today. There is no
delete-operation route and no automatic cleanup job. An operation created
without an account header stays anonymous and is not linked to anything
else.

## Receipts and evidence

Signed PREFLIGHT and Commerce receipts (`receipts` table) are append-only
and retained indefinitely — this is by design, not an oversight: a
receipt's whole purpose is to remain independently verifiable later.
Durable execution bindings and on-chain observations
(`execution_bindings`, `commerce_observations`) are likewise append-only
and retained indefinitely; nothing here is ever deleted or overwritten.

## Investigation data

An investigation (`GET /me/operations/:id/investigation`) is **assembled
on request** from the tables above — it is not itself a separately
stored record. Its export (`.../investigation/export`) is generated the
same way at request time; the export file itself is not retained by OCD
after being returned to the caller (only the underlying operation/
receipt/observation data it was built from persists, per the sections
above).

## Caller-reported merchant response evidence

`merchant_evidence` rows are retained indefinitely, append-only, no
delete route. Each row is explicitly and permanently labeled
`source: CALLER_REPORTED` (a database `CHECK` constraint enforces this —
it can never be upgraded to any other value). **The raw merchant response
body is never accepted as input and never stored** — only a SHA-256
digest, byte count, HTTP status, content type, and a 3-item response-
header allowlist (`etag`, `content-length`, `x-request-id`; everything
else submitted is silently dropped before it reaches storage).

## Webhook configuration and delivery metadata

Webhook endpoint URLs, delivery attempts, HTTP status codes, and
timestamps (`webhook_endpoints`, `webhook_events`, `webhook_deliveries`)
are retained indefinitely today — no automatic cleanup job exists. A
customer can delete their own webhook endpoint (`DELETE
/me/webhooks/:id`), which also removes its delivery history (a database
cascade). There is currently no way to delete an account or an
operation.

One deliberate exception to the "sensitive values are hash-only" rule
below: a webhook's `signing_secret` is stored server-side in plain text
(not hashed) — this is intentional, not an oversight, because OCD must
use the raw secret to sign every outbound delivery to the customer's
endpoint. It is never returned by any `GET` request after creation, shown
to the customer exactly once, and never appears in any webhook payload.

## Secrets, private keys, and payment credentials

- **OCD never asks for, receives, or stores a customer's wallet private
  key or payment-provider credentials at any point.** Every OCD route in
  this repo only ever sees a transaction hash and public on-chain data
  after the customer's own wallet/provider has already executed a
  payment — never a signing key.
- An operation's `recovery_credential`, an account's `api_key`, and a
  preflight's finalization capability are each shown to the caller
  **exactly once** and only their SHA-256 hash is ever persisted — the
  raw value cannot be recovered from the database even by OCD.
- The Ed25519 key that signs every receipt lives in exactly one place — a
  separate HTTP API deployment's own environment variable — and is never
  copied into this MCP server or any database row.

## Genuine gap to flag before a larger/enterprise pilot

**No automatic data-retention or deletion policy exists today** for any
of the tables above, and there is no way for a customer to request
deletion of their own operation/account data via the API. For a small,
founder-led technical pilot this is disclosed openly rather than hidden;
it is not addressed as a new engineering task in this document. Before
onboarding a larger or more compliance-sensitive customer, this would
need either (a) an explicit written retention commitment, or (b) an
actual deletion mechanism — neither exists yet, and none should be
implied to a pilot customer today.

Until a formal retention policy exists, the honest statement to give a
pilot customer is: **operational records (operations, receipts,
evidence, webhook configuration/delivery history) are retained in the
current pilot environment until manually removed or until a formal
retention policy is introduced** — not "retained for N days," because no
such enforcement exists.
