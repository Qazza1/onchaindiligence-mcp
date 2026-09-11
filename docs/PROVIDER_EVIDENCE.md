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
