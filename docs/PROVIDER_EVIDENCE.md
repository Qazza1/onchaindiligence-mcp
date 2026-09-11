# Provider evidence (D3.4C1)

Provider evidence records what an execution provider or x402 facilitator
reported for one OCD operation. It is append-only and content-addressed.

It is not an OCD chain observation. A provider response such as `success:
true` with a transaction hash is preserved as a claim; OCD independently
observes Base USDC settlement before reporting settlement as confirmed.

## x402 facilitator claim input

`POST /operations/:operationId/provider-evidence` is gated by the operation
recovery credential. It accepts a normalized standard x402 settle-response
shape, for example:

```json
{
  "x402_settle_response": {
    "x402Version": 2,
    "success": true,
    "transaction": "0x…",
    "network": "eip155:8453",
    "payer": "0x…",
    "amount": "1000"
  },
  "correlation_reference": "provider-payment-request-id",
  "raw_reference_digest": "sha256:<digest>",
  "execution_request_id": "OCD-EXEC-…"
}
```

Failures use `success: false` and require `error` or `error_digest`.
`raw_response` is not accepted or stored. The optional digest is the safe
reference to retained raw provider material; credentials, payment payloads,
and arbitrary headers are never persisted by this interface.

The response exposes the normalized identifier, claimed state, transaction
claim, operation/execution reference, source-authentication label, and
idempotent-replay status. An explicitly supplied execution request must belong
to the operation. Provider execution IDs, correlation references, x402 payment
identities, transaction hashes, and provider event IDs remain separate fields.

## Reconciliation and binding

The authenticated investigation exposes `provider_evidence` separately from
`settlement` and `evidence`. It maps provider terminal claims into the existing
D3.3 status rules:

- success + no OCD observation → `SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED`;
- success + independently observed mismatch → existing mandate/observation
  mismatch findings;
- failure + independently observed settlement → existing execution and
  settlement status contradictions.

A provider transaction hash never changes `TRANSFER_MATCH_ONLY`,
`EXECUTOR_CORRELATED`, or `PAYMENT_IDENTITY_LINKED`. Only the existing durable
binding and independent observation logic establish those levels.

Provider evidence is intentionally not added to Action Receipt v1 in this
milestone. It remains durable authenticated investigation evidence. A future
receipt version can reference this evidence only through an explicit,
versioned, signed contract change.

## PayBox request claim input (D3.4C2)

The same endpoint also accepts a terminal PayBox request snapshot. This is
normalization of PayBox's own public request result; it does not cause OCD to
submit, authorize, or finalize a payment.

```json
{
  "provider_version": "v1-gateway",
  "execution_request_id": "OCD-EXEC-…",
  "paybox_response": {
    "request_id": "…",
    "status": "success",
    "output_id": "…",
    "audit_id": "…",
    "payment": { "gateway": true, "status": "succeeded", "ok": true, "network": "eip155:8453", "scheme": "exact" },
    "response": { "status": 200, "ok": true }
  }
}
```

Only terminal `success`, `denied`, and `error` states are recorded. Pending
approval/signature remains unresolved execution state, not a provider failure.
For PayBox, the request ID must exactly match the existing operation binding's
`provider_reference` (`paybox:<request_id>`) and that binding must identify
the existing PayBox executor. The adapter keeps the request/result identity
and a digest of safe response metadata; it does not store authorization
headers, credentials, raw response bodies, or an inferred transaction hash.

`success` is a PayBox provider claim. OCD only reports settlement after its
own chain observation. Gateway-mode claims do not alter the existing
`TRANSFER_MATCH_ONLY` cap, and PayBox's own approval model (including any
"Always Ask" configuration) remains independent of OCD `ALLOW` or
`REQUIRE_APPROVAL` policy decisions.

## Turnkey transaction-status evidence (D3.4C3)

Turnkey exposes two distinct mechanisms, confirmed directly against current
official Turnkey documentation: a standalone `SIGN_TRANSACTION` activity
that signs only (no broadcast, no transaction hash), and `ethSendTransaction()`
(sign + broadcast in one call), whose progress is tracked by
`sendTransactionStatusId` via polling or the `transaction:status` webhook.
Only the combined send/track lifecycle is accepted as provider evidence here
— a bare signing activity proves a signature was produced, never that
anything was broadcast, included, or settled.

`POST /webhooks/turnkey/transaction-status` receives Turnkey's own signed
push notification directly (not the recovery-credential-gated caller-reported
endpoint above — Turnkey pushes evidence to OCD, it is not relayed by the
caller). Every delivery is Ed25519-signature-verified against Turnkey's
public JWKS (`GET https://api.turnkey.com/public/v1/discovery/webhooks/jwks`)
before anything in the body is trusted, per Turnkey's documented
`v1.ed25519.<key-id>.<timestamp>.<event-id>.<raw-body>` signed format, a
5-minute replay window, and fail-closed rejection of any signature algorithm
or version other than the current `ed25519`/`v1`. **A verified signature
means "Turnkey authored this claim." It never means "the payment settled."**

Only `INCLUDED` and `FAILED` are terminal. `BROADCASTING` is acknowledged
(so Turnkey does not endlessly retry a delivery OCD has no use for) but is
never recorded as provider evidence. An `INCLUDED` message that also carries
Turnkey's documented on-chain-revert `error` is recorded as `FAILED`, not
`SUCCEEDED` — the transaction landed, but did not succeed.

The webhook carries no OCD operation id. Correlation is one-directional and
entirely OCD-owned: `sendTransactionStatusId` becomes
`turnkey:<sendTransactionStatusId>`, which must exactly match an existing
durable `execution_bindings.provider_reference` (established by the
executor at `submit()` time, D2.6's model) belonging to a Turnkey execution
binding. A webhook with no matching durable binding is acknowledged but
never attached to an arbitrary operation. Duplicate deliveries (a Turnkey
retry of the same event) are absorbed by the existing content-addressed
`provider_evidence` idempotency — no separate webhook-event-id table exists
or is needed.

Field mapping: `provider_execution_id` is Turnkey's `sendTransactionStatusId`
(the durable send/track identity); `provider_event_id` is the webhook
delivery's own `X-Turnkey-Event-Id` header (Turnkey's documented stable
per-event/retry-dedupe identifier — the existing semantic intent of this
field), not the signing `activityId`. `activityId` is retained only inside
`raw_reference_digest`, since no current Turnkey documentation establishes a
durable guaranteed linkage between an `activityId` and the
`sendTransactionStatusId` it may accompany — that correlation is treated as
unknown, not assumed. As with every other provider, `payer`/`amount`/`asset`/
`recipient` are left null: Turnkey's transaction-status message does not
assert them, and a provider claim must never be made to look like an
assertion the provider did not actually make.

A verified Turnkey webhook alone never raises binding strength past
`TRANSFER_MATCH_ONLY`. `EXECUTOR_CORRELATED` requires the existing durable
execution-binding correlation plus Turnkey's own direct
`sendTransactionStatusId → txHash` claim (a direct provider-asserted
linkage, unlike PayBox gateway mode's conservative log-search recovery).
`PAYMENT_IDENTITY_LINKED` still requires the same independently-decoded
on-chain authorizer match every other executor needs; `commerceLifecycle.ts`
is unmodified.
