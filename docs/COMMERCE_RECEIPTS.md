# Commerce Receipts, Finalization Capabilities, Durable Storage (D2.2)

"After execution, OnChainDiligence independently checks what actually
happened and produces a portable receipt binding the two."

This is the post-flight half of `docs/PAYMENT_PREFLIGHT.md`'s flow. It never
charges a second x402 payment: the $0.01 paid at `preflight_payment` time
already buys the preflight evaluation, the signed PREFLIGHT receipt, **and**
one bounded post-flight finalization capability. Finalizing that capability
into a Commerce Receipt is free.

## Finalization capability

Returned once, inline, in a successful `preflight_payment` response's
`finalization.capability` field:

- 256 bits of `crypto.randomBytes`, base64url-encoded.
- Only `sha256(token)` is ever stored (`finalization_capabilities.capability_hash`)
  — the raw token is never written to durable storage, never logged, and
  never appears in any receipt.
- Authorizes exactly one thing: creating one Commerce Receipt for the exact
  PREFLIGHT lifecycle (receipt id + digest) it was minted against. **It does
  not authorize payment.**
- Bounded TTL, default 24 hours, configurable via
  `FINALIZATION_CAPABILITY_TTL_HOURS`. Expiry is returned to the caller
  (`finalization.expires_at`) and enforced server-side; an expired capability
  fails clearly and is never silently replaced.
- Single-use, consumed atomically with publishing its Commerce Receipt (see
  Storage below) — never before every step that can fail has already
  succeeded.

## POST /receipts/finalize

Free, but capability-protected:

```
Authorization: Bearer <finalization capability>
Content-Type: application/json

{
  "transaction_hash": "0x...",
  "execution_provider": "x402" | "paybox" | "wallet" | "other",
  "provider_reference": null,
  "result_digest": null
}
```

Not a generic receipt-creation endpoint: `amount`, `recipient`, `asset`,
`sender`, and `network` are **rejected** if the caller supplies them (400) —
those settlement facts come only from the bound PREFLIGHT receipt and
independent chain observation, never from a caller claim. There is no public
unauthenticated write path anywhere in this product; this is the only write
into durable storage besides a preflight's own opt-in publication of itself.

## v1 chain/asset scope

Base mainnet (`eip155:8453`) ERC-20 transfers only, Base USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals) as the only
supported asset. A different network/asset combination fails clearly (400)
rather than pretending to support it. `src/settlement.ts`'s per-network,
per-asset registry is structured to extend cleanly — but nothing here fakes
multi-chain support that doesn't exist yet.

## Independent settlement verification

OCD never trusts a caller's, PayBox's, or an x402 facilitator's claim that a
payment succeeded. `src/settlement.ts` reads the transaction receipt and logs
directly from a Base JSON-RPC endpoint (reusing the existing viem
dependency), and reports only what it actually observed:

1. Transaction not found (yet, or ever) -> never fabricated as confirmed.
2. Transaction reverted -> execution `FAILED`, settlement `NOT_CONFIRMED`.
3. Transaction confirmed, but no ERC-20 Transfer of the expected asset at
   all -> execution `CONFIRMED` (the tx itself succeeded), settlement
   `NOT_CONFIRMED` (the *specific proposed payment* did not happen).
4. Transaction confirmed, and a Transfer matching the preflight's asset,
   recipient, amount (and sender, if the preflight required one) is found ->
   execution `CONFIRMED`, settlement `CONFIRMED`.
5. Confirmed but below the configured minimum confirmation depth
   (`BASE_MIN_CONFIRMATIONS`, default 1) -> settlement `UNVERIFIED` (pending),
   never prematurely `CONFIRMED`.

**`settlement: CONFIRMED` means the observed transaction settled — it never
by itself means "matched what was authorized."** That is a separate,
explicit `execution-matches-preflight` check (plus five field-level
`*-matches-preflight` checks). A transaction can settle while paying the
wrong recipient or amount; the Commerce Receipt captures that mismatch
directly rather than hiding it — a receipt showing `ALLOW 1 USDC -> 0xABC`
proposed but `2 USDC -> 0xDEF` observed, `execution: CONFIRMED`, `settlement:
NOT_CONFIRMED` is valuable evidence, not something to suppress.

Amounts are converted to on-chain atomic units deterministically
(`src/money.ts`); a preflight amount with more decimal precision than the
asset supports (e.g. 7 digits against USDC's 6) is rejected as a match
rather than silently rounded.

### Checks emitted on every Commerce Receipt

`preflight-receipt-valid`, `transaction-found`, `transaction-success`,
`network-matches-preflight`, `asset-matches-preflight`,
`recipient-matches-preflight`, `amount-matches-preflight`,
`sender-matches-preflight` (`NOT_CHECKED` if the preflight didn't require a
specific sender), `execution-matches-preflight` (the five match checks
combined), `settlement-confirmed`, and `service-delivery-verification`
(always `NOT_CHECKED` in v1 — see below).

`decision` is copied **verbatim** from the original PREFLIGHT receipt; a
Commerce Receipt never re-runs policy evaluation, and its limitations say so
explicitly.

### `result_digest`

An optional caller-supplied `sha256:...` digest is recorded only as a
**caller-provided claim** (`service-delivery-verification: NOT_CHECKED`) —
OnChainDiligence does not independently observe resource/service delivery in
v1, and never phrases a caller-supplied digest as "OnChainDiligence verified
this was delivered."

## Storage

**Selected: Postgres, via Vercel's native Neon-backed Postgres integration.**
Before D2.2, this deployment had zero marketplace/storage integrations at
all (confirmed via `vercel integration installations`) — Vercel Postgres was
the smallest durable option actually reachable without adding an unrelated
third-party service. Two small tables, no ORM (`db/schema.sql`, applied via
`npm run db:migrate`):

- `receipts(receipt_id PK, receipt_digest, receipt_type, envelope_json,
  is_public, created_at)` — every successful preflight is inserted here
  (`is_public` from the caller's `publication` choice), and every finalized
  Commerce Receipt too. Append-only: same id + same content is an idempotent
  no-op; same id + different content fails closed
  (`ReceiptConflictError`) — a receipt's content is never overwritten.
- `finalization_capabilities(capability_hash PK, preflight_receipt_id,
  preflight_receipt_digest, expires_at, used_at, consumed_transaction_hash,
  commerce_receipt_id, publish_commerce, created_at)`.

Consuming a capability and publishing its Commerce Receipt happens in **one
Postgres transaction** (`consumeCapabilityAndPublish`, using
`@neondatabase/serverless`'s `Pool` for a real interactive
`SELECT ... FOR UPDATE` + conditional `INSERT`/`UPDATE`) — they either both
happen or neither does. A retry with the identical transaction hash after a
prior success returns the same existing Commerce Receipt idempotently; a
retry with a *different* transaction hash after a prior success is rejected.
No enumeration query exists anywhere in this product — every read is an
exact lookup by receipt_id or capability hash.

## First real Commerce Receipt

D2.2 does not execute a payment. It prepares the architecture so the
previously-planned one-shot $0.01 OCD x402 activation can become the first
real Commerce Receipt: pay $0.01 USDC on Base for a real OCD service, take
the resulting transaction hash, finalize it through this exact flow. Because
OCD is both the seller and the receipt issuer in that first activation, that
limitation must be disclosed plainly wherever it is referenced — it is a
real, value-bearing system test, not evidence of OCD's independent-witness
role against a third party. A payment to an independent third-party x402
service is the follow-up needed to demonstrate that.
