# OnChainDiligence Pilot Quickstart

For a first real pilot customer integrating the full OCD flow: **you keep
your existing wallet and payment provider — OCD sits alongside it as an
independent evidence and reconciliation layer**, not a replacement for
either.

Base URL below is `https://mcp.onchaindiligence.com`; substitute your
deployment's URL if different. Every step is either free or a small,
explicit x402 payment (never silent, never bundled into a larger charge).

## 0. What OCD does (and does not do)

Before payment, OCD evaluates a proposed payment against your policy and
returns a decision. After your own wallet/provider executes the payment,
OCD independently observes on-chain settlement (where the network/asset
is supported) and produces a signed receipt binding the two together —
so "the agent decided to pay" and "the payment actually settled" are
never conflated.

OCD does **not**: custody funds, authorize wallet spending, guarantee
safety or compliance, prove that a merchant delivered a service, detect
fraud, or claim a partnership with any specific execution provider
(PayBox or otherwise) — it is compatible with whichever provider you
already use. Every claim OCD makes is stated explicitly and narrowly:
preflight returns `ALLOW` / `REQUIRE_APPROVAL` / `BLOCK`; a receipt's
proof is `VALID` / `INVALID` / `UNVERIFIABLE`; settlement is
independently observed or it isn't; merchant response evidence is always
labeled `CALLER_REPORTED`, never independently verified by OCD; binding
strength (how strongly a settlement is tied to a specific execution
request) is stated explicitly, never implied.

## 1. Integration prerequisites

- An existing wallet/execution path that can sign and submit an on-chain
  payment yourself (PayBox is one compatible option, not a requirement —
  any x402-capable or direct on-chain execution path works).
- Base mainnet USDC is the only network/asset OCD independently observes
  settlement for today (v1 scope, stated honestly — not a hidden
  limitation).
- A small amount of USDC to pay OCD's own per-call fees ($0.01 for a
  preflight call; see the price list in `docs/BAZAAR_ACTIVATION.md` for
  every other paid check).

## 2. Choose MCP or HTTP/x402

Two equivalent integration paths, same underlying routes:

- **MCP** (`https://mcp.onchaindiligence.com/mcp`) — if your agent
  runtime already speaks MCP (Claude, ChatGPT via a custom connector,
  or any MCP-compatible client), add this server and use its tools
  directly (`preflight_payment`, `get_receipt`, `verify_receipt`,
  `screen_wallet`, `screen_name`, `verify_uk_company`,
  `verify_us_company`, `diligence`, `inspect_payment`).
- **HTTP/x402** — call the REST routes directly (examples below), paying
  each priced call via a standard x402 client. Better fit for a
  non-MCP backend or a custom agent framework.

Both paths hit the exact same server-side logic — pick whichever is less
integration work for your stack.

## 3. Create an account (free, optional but recommended for a pilot)

No signup form, no email. `POST /accounts` is free and returns a random
`account_id` plus an `api_key` — the key is shown **exactly once**.

```bash
curl -s -X POST https://mcp.onchaindiligence.com/accounts
```

```json
{ "account_id": "OCD-ACC-...", "api_key": "..." }
```

There is no way to retrieve the key again if lost — only a new account
can be created. It grants no payment authority and no access to any
operation's own `recovery_credential`; it can only list/read operations
tagged with this account's id, and manage this account's own webhooks.
Store it like any other API key — never commit it to source control. An
operation created without this header stays anonymous, exactly as
before D2.7 existed — the account layer is additive, not required.

## 4. Open an operation

```bash
curl -s -X POST https://mcp.onchaindiligence.com/operations \
  -H "Authorization: Bearer <api_key>"
```

```json
{ "operation_id": "OCD-OP-...", "recovery_credential": "..." }
```

One operation = one intended payment, start to finish. Keep the
`recovery_credential` too — it's what authorizes resuming/finalizing
*this specific* operation later (unrelated to your account key).

## 5. Payment preflight — before you pay anything

```bash
curl -s -X POST https://mcp.onchaindiligence.com/x402/lifecycle/preflight-payment \
  -H "x-ocd-operation-id: <operation_id>" \
  -H "x-ocd-recovery-credential: <recovery_credential>" \
  -H "Content-Type: application/json" \
  -d '{
    "action": {
      "kind": "PAYMENT",
      "resource": "https://your-merchant.example/api",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1.00",
      "sender": null,
      "recipient": "0xMerchantRecipientAddress..."
    },
    "policy": {
      "max_amount": "5.00",
      "allowed_networks": ["eip155:8453"],
      "allowed_assets": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      "expected_recipient": "0xMerchantRecipientAddress...",
      "allowed_resource_origins": ["https://your-merchant.example"],
      "expected_payer": "0xYourWalletAddress..."
    },
    "options": { "screen_recipient_sanctions": true },
    "references": { "mandate_digest": null }
  }'
```

$0.01, paid via standard x402. Returns a decision (`ALLOW` /
`REQUIRE_APPROVAL` / `BLOCK`) with reasons, plus a signed PREFLIGHT
receipt and a one-time finalization capability. **`ALLOW` here is a
policy opinion, not an authorization to spend — your own wallet/provider
still independently decides whether to actually sign and submit.**

## 6. Execution — by your own wallet/provider, not OCD

OCD never signs or submits the payment. Register a durable execution
binding (so a crash mid-submission is recoverable, never silently
resubmitted), then have your wallet/provider actually execute:

```bash
curl -s -X POST https://mcp.onchaindiligence.com/operations/<operation_id>/execution-bindings \
  -H "x-ocd-recovery-credential: <recovery_credential>" \
  -H "Content-Type: application/json" \
  -d '{
    "client_submission_key": "<your-own-idempotency-key>",
    "executor_identity": "your-executor-name",
    "executor_version": "v1",
    "recovery_capability_class": "stable-payment-identity"
  }'
```

Then submit the payment through whatever you already use — your own
signer, PayBox, or any other x402/on-chain execution path. PayBox is one
executor OCD's SDK already supports well; it is not a requirement, and
using a different provider does not lose any OCD functionality.

## 7. Observation and receipt

Once you have a transaction hash, finalize:

```bash
curl -s -X POST https://mcp.onchaindiligence.com/operations/<operation_id>/finalize \
  -H "Authorization: Bearer <finalization_capability_from_step_5>" \
  -H "Content-Type: application/json" \
  -d '{
    "execution_request_id": "<from_step_6>",
    "transaction_hash": "0x...",
    "execution_provider": "other",
    "provider_reference": null,
    "result_digest": null
  }'
```

OCD independently re-reads the transaction from Base — it never trusts a
caller's claim that a payment succeeded. The response is a signed
Commerce receipt: `settlement.status` (`CONFIRMED` / `NOT_CONFIRMED` /
`UNVERIFIED`) and a `proof` anyone can independently re-verify
(`GET /verify-receipt` or the `verify_receipt` MCP tool). The receipt
also states a **binding strength** (how strongly the observed settlement
is tied to your specific execution request) — an honest signal, not
something to hide when it's conservative.

## 8. Operation history and investigation

```bash
curl -s https://mcp.onchaindiligence.com/me/operations \
  -H "Authorization: Bearer <api_key>"
```

Bounded, newest-first. `GET /me/operations/:operation_id` returns full
lifecycle detail; every response includes a `recovery` object
(`needsAttention`, `mayAlreadyHavePaid`, `safeNextAction`) so a stuck or
ambiguous operation is never silently retried as a fresh payment.

`GET /me/operations/:operation_id/investigation` assembles the same
information into one object for support/compliance review:
preflight/execution/settlement/evidence/receipts/recovery, plus (see
below) `findings` and `merchant_response`.
`GET /me/operations/:operation_id/investigation/export` wraps it in a
self-describing, digest-stamped `onchaindiligence.investigation.v1`
package suitable for a support ticket or compliance record — no secrets
included.

## 9. Findings — deterministic, not AI-generated

Every investigation includes a `findings` array: deterministic checks
against the evidence already on file — no AI analyst, no fraud scoring,
no new evidence source. Examples: `RECEIPT_INVALID`,
`MANUAL_RECOVERY_REQUIRED`, `SENDER_MISMATCH`,
`EXPECTED_PAYER_MISMATCH`, `SETTLEMENT_NOT_CONFIRMED`,
`WEAK_ATTRIBUTION` (informational — a conservative binding strength is
disclosed, not treated as an error). This is what turns a raw payment
log into something a support or compliance reviewer can actually act on.

## 10. Caller-reported merchant response evidence (optional)

If your integration also wants to record what the merchant's API
actually returned after payment, attach it explicitly — labeled
honestly as **your own report**, never independently verified by OCD:

```bash
curl -s -X POST https://mcp.onchaindiligence.com/operations/<operation_id>/merchant-evidence \
  -H "x-ocd-recovery-credential: <recovery_credential>" \
  -H "Content-Type: application/json" \
  -d '{
    "resource_url": "https://your-merchant.example/api/order/123",
    "http_status": 200,
    "content_type": "application/json",
    "response_body_digest": "sha256:<64 hex chars>",
    "response_bytes": 512,
    "response_headers": { "etag": "...", "content-length": "512" }
  }'
```

Only a SHA-256 digest and a 3-header allowlist are ever stored — never
the raw response body. This is what powers `MERCHANT_RESPONSE_ERROR` and
`MERCHANT_RESPONSE_CONTRADICTION` findings, always worded as
caller-reported, never framed as fraud or as OCD proving delivery.

## 11. Webhooks — get notified instead of polling

```bash
curl -s -X POST https://mcp.onchaindiligence.com/me/webhooks \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-service.example/webhooks/ocd"}'
```

```json
{ "webhook_id": "OCD-WHK-...", "url": "...", "status": "active", "created_at": "...", "signing_secret": "whsec_..." }
```

`signing_secret` is shown **once**. You'll receive
`operation.preflight_completed`, `.execution_updated`,
`.recovery_required`, `.settlement_updated`, and `.receipt_produced`
events. Delivery is not instant — a background worker picks up new
events (currently roughly every minute) and retries a failed delivery at
1/5/30-minute intervals before giving up.

Verify every delivery — never trust an unsigned payload:

```bash
OCD_WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.mjs
```

```js
const expected = 'v1=' + hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
// constant-time compare `expected` against the X-OCD-Webhook-Signature header
```

Always verify over the **raw, unparsed** body, before `JSON.parse()`.
Deduplicate retried deliveries using the envelope's `id` (reused across
retries of the same delivery, never a new one).

## In the app

The same flow (minus raw preflight/execution/finalize calls, which are
integration-side) is browsable in `onchaindiligence-app`: **Operation
history** (connect/create an account, browse, open an operation, view
investigation, findings, and merchant response, "Export JSON" / "Copy
investigation summary") and **Webhooks** (add an endpoint, see delivery
history).
