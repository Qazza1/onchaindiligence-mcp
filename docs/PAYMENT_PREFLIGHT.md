# Payment Preflight v1 (D2.1)

"Before an autonomous agent pays, OnChainDiligence evaluates the proposed
payment against a caller-defined structured policy and evidence, then issues
a portable signed PREFLIGHT receipt explaining the decision."

**OCD is not the wallet.** It does not hold funds, does not execute the
payment, and does not override wallet/PayBox/x402-client authorization.
Preflight produces a recommendation with a verifiable paper trail; the
execution layer applies its own, independent authorization afterward:

```
agent -> OCD preflight -> ALLOW / REQUIRE_APPROVAL / BLOCK
                              |
                              v
                    wallet / PayBox / x402 client
                    applies its OWN authorization
                              |
                              v
                          execution
                              |
                              v
                    OCD Commerce Receipt (future)
```

Both gates are independent. An `ALLOW` from preflight never means the
execution provider will proceed, and a wallet's own authorization never
substitutes for a preflight evaluation.

Two transports, one service: `POST /x402/preflight-payment` (HTTP x402, $0.01)
and the `preflight_payment` MCP tool ($0.01) both call the same
`preflightPayment()` function in `src/preflight.ts` — there is exactly one
policy engine to keep correct.

## Scope: structured policy only

v1 accepts only deterministic, structured fields. There is no
natural-language policy interpreter — `"don't spend too much and only use
safe companies"` has no defensible deterministic meaning, and this service
does not attempt to give it one. A future mandate compiler may translate
human intent into the structured shape below; preflight itself never does
that translation.

## Input

```json
{
  "action": {
    "kind": "PAYMENT",
    "resource": "https://service.example/api",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "1.00",
    "sender": null,
    "recipient": "0x000000000000000000000000000000000000dEaD"
  },
  "policy": {
    "max_amount": "5.00",
    "allowed_networks": ["eip155:8453"],
    "allowed_assets": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    "expected_recipient": null,
    "allowed_resource_origins": ["https://service.example"]
  },
  "options": { "screen_recipient_sanctions": true },
  "references": { "mandate_digest": null }
}
```

- `network` is CAIP-2 (e.g. `eip155:8453` for Base mainnet) — never a bare
  chain name.
- `asset` is the canonical ERC-20 **contract address**, matching the same
  `asset` field x402's own `PaymentRequirements` uses — never a ticker like
  `"USDC"`. `null`/absent policy fields mean "no restriction configured" for
  that dimension, not "checked and passed."
- `amount` / `max_amount` are canonical decimal strings (`"1.00"`, never
  `1.0` or `1.5e2`) — comparisons are exact digit-string comparisons, never
  floating point.
- Every wallet-shaped field (`recipient`, `sender`, `expected_recipient`,
  `allowed_assets` entries) is a 0x EVM address in v1.

## Decision rules

Each policy dimension the caller actually configured becomes one check.
Unconfigured dimensions produce no check at all (not a silent pass).

| Bucket | Result | Example |
|---|---|---|
| Hard policy violation | **BLOCK** | amount exceeds `max_amount`; network/asset/recipient/origin not on the configured list |
| Insufficient evidence | **REQUIRE_APPROVAL** | sanctions screening requested but the oracle is unreachable; an origin restriction configured but no `resource` URL to check it against |
| Everything configured passes | **ALLOW** | — |

Precedence: any `BLOCK`-class failure wins even if something else is merely
`UNKNOWN`. `UNKNOWN` is never silently treated as `PASS`. `amount ==
max_amount` is `ALLOW`, not `BLOCK`.

### Sanctions screening

`options.screen_recipient_sanctions: true` screens the recipient wallet
against the same Chainalysis on-chain oracle the other tools use. A match is
`BLOCK`. An oracle failure is `REQUIRE_APPROVAL`, never a silent pass, and a
clean result is worded precisely — **"not found on the sanctions oracle,"
never "safe wallet."** Absence from one source is not a general safety
claim.

## Example: ALLOW

Amount `4.99` against `max_amount: "5.00"`, everything else on its allowlist:

```json
{
  "decision": { "status": "ALLOW", "authorized": true, "reasons": ["All configured policy checks passed."] },
  "checks": [
    { "id": "amount-within-max", "result": "PASS", "summary": "The proposed amount is within the caller-configured maximum.", "evidence_digest": null }
  ],
  "receipt": {
    "schema": "onchaindiligence.public-action-receipt.v1",
    "receipt": {
      "receipt_type": "PREFLIGHT",
      "execution": { "status": "NOT_SUBMITTED", "transaction_hash": null },
      "settlement": { "status": "NOT_APPLICABLE" }
    },
    "proof": { "signed": true, "algorithm": "ed25519" }
  }
}
```

## Example: BLOCK (policy violation)

Same request, amount `5.01`:

```json
{
  "decision": {
    "status": "BLOCK",
    "authorized": false,
    "reasons": ["The proposed amount exceeds the caller-configured maximum."]
  },
  "checks": [
    { "id": "amount-within-max", "result": "FAIL", "summary": "The proposed amount exceeds the caller-configured maximum.", "evidence_digest": null }
  ]
}
```

Note what is absent: the actual configured `max_amount` value never appears
in the public check text — only whether the proposal passed against it.
Prefer minimal disclosure everywhere a public receipt might be published.

## Receipt

Every evaluation produces a `receipt_type: "PREFLIGHT"` envelope, signed
through the same `/attest` endpoint (`purpose: "public-action-receipt"`) as
every other Public Action Receipt (see `docs/PUBLIC_ACTION_RECEIPT_V1.md` in
the `onchaindiligence` repo). `execution` is always
`{provider: null, status: "NOT_SUBMITTED", transaction_hash: null}` and
`settlement.status` is always `"NOT_APPLICABLE"` — preflight never claims
execution happened. `preflightPayment()` independently re-verifies the
receipt's proof as `VALID` before returning; if it cannot, the call fails
closed rather than returning a result with an unverifiable signature.

`references.mandate_digest`, if supplied, appears only as a
`mandate-digest-referenced` check referencing the digest — OnChainDiligence
never sees or verifies the private mandate content behind it.

### Limitations disclosed on every receipt

- OCD does not execute the payment.
- `ALLOW` does not guarantee the execution provider will authorize or
  complete the payment.
- Sanctions screening does not establish beneficial ownership or general
  safety.
- Later execution may differ from the proposed action unless the execution
  layer independently binds itself to this preflight receipt (planned for
  D2.2).

## Dynamic receipt publication: deferred

`GET /receipts/:receiptId` currently serves only a small **bundled, static**
registry (D2.0A) — it is not dynamic storage, and this task does not add any.
This deployment has no database or KV store today; adding one "just because
preflight receipts need a home" was explicitly out of scope for D2.1.
Preflight receipts are returned **inline** in the response and are not yet
independently resolvable by ID. D2.2 needs, at minimum: immutability keyed by
receipt ID/digest, idempotent duplicate writes, fail-closed handling of a
conflicting write to the same ID, no public enumeration, no unauthenticated
writes, and only `VALID`-verified public receipts ever published.
