# D2.7 Pilot Quickstart

For a first external pilot user of the D2.7 operational product layer:
authenticated operation history, recovery center, account webhooks, and
investigation/export. Assumes D2.7 has already been merged and deployed
(see the repo's D2.7 status notes) -- this doc does not cover deployment.

Base URL below is `https://mcp.onchaindiligence.com`; substitute your
deployment's URL if different.

## 1. Create an account

No signup form, no email. `POST /accounts` is free and returns a random
`account_id` plus an `api_key` -- the key is shown **exactly once**.

```bash
curl -s -X POST https://mcp.onchaindiligence.com/accounts
```

```json
{ "account_id": "OCD-ACC-...", "api_key": "..." }
```

## 2. Save the API key

There is no way to retrieve it again if lost -- only a NEW account can be
created. It grants no payment authority and no access to any single
operation's `recovery_credential` -- it can only list/read operations
tagged with this account's id, and manage this account's own webhooks.

Store it like any other API key (environment variable, secrets manager) --
never commit it to source control.

## 3. Create an owned operation by sending account auth

The **same** existing `POST /operations` route creates an operation as
before -- adding your account's `Authorization` header is what makes it
show up in your private history. This is entirely optional per-operation;
an operation created without this header stays anonymous, as it always has.

```bash
curl -s -X POST https://mcp.onchaindiligence.com/operations \
  -H "Authorization: Bearer <api_key>"
```

```json
{ "operation_id": "OCD-OP-...", "recovery_credential": "..." }
```

Keep the `recovery_credential` too -- it's what an SDK client uses to
resume/execute this specific operation (unrelated to your account key).

## 4. View operation history

```bash
curl -s https://mcp.onchaindiligence.com/me/operations \
  -H "Authorization: Bearer <api_key>"
```

Returns a bounded, newest-first list. `GET /me/operations/:operation_id`
returns the full lifecycle detail for one operation (preflight, execution
bindings, observations, receipts, and a `recovery` object).

## 5. Inspect recovery status

Every operation detail response includes a `recovery` object:

```json
{
  "needsAttention": true,
  "mayAlreadyHavePaid": true,
  "summary": "A submission attempt was made but its outcome is not yet known.",
  "safeNextAction": "Resume this exact operation ... Never retry it as a new payment."
}
```

`GET /me/operations/:operation_id/investigation` gives the same information
reshaped into a fuller operation/preflight/execution/settlement/evidence/
receipts/recovery object, useful for support/compliance review.

## 6. Configure a webhook

```bash
curl -s -X POST https://mcp.onchaindiligence.com/me/webhooks \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-service.example/webhooks/ocd"}'
```

```json
{ "webhook_id": "OCD-WHK-...", "url": "...", "status": "active", "created_at": "...", "signing_secret": "whsec_..." }
```

`signing_secret` is shown **once**, exactly like the account API key.
You'll receive `operation.preflight_completed`, `.execution_updated`,
`.recovery_required`, `.settlement_updated`, and `.receipt_produced`
events for operations owned by this account. Delivery is not immediate --
a background worker (cron) picks up new events, typically within about a
minute, and retries a failed delivery at 1/5/30-minute intervals before
giving up.

## 7. Verify a webhook signature

Every delivery carries `X-OCD-Webhook-Id`, `X-OCD-Webhook-Timestamp`, and
`X-OCD-Webhook-Signature: v1=<hex>` (HMAC-SHA256 of
`"<timestamp>.<raw body>"` with your `signing_secret`).

A minimal, real, runnable verifier:

```bash
OCD_WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.mjs
```

(in `onchaindiligence-mcp` -- see that file for the full implementation).
The core check, in any language:

```js
const expected = 'v1=' + hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
// constant-time compare `expected` against the X-OCD-Webhook-Signature header
```

Always verify over the **raw, unparsed** request body -- verify before you
`JSON.parse()` it. Deduplicate retried deliveries using the envelope's
`id` field (the same event id is reused across retries of the same
delivery, never a new one).

## 8. Download an investigation as JSON

```bash
curl -s https://mcp.onchaindiligence.com/me/operations/<operation_id>/investigation/export \
  -H "Authorization: Bearer <api_key>" \
  -o investigation.json
```

The file is a self-describing `onchaindiligence.investigation.v1` package:
a manifest (`schema`, `generated_at`, `operation_id`, `account_id`,
`artifacts`, a deterministic `digest`) wrapping the same investigation
content from step 5 -- suitable for attaching to a support ticket,
compliance review, or handing to another system. It contains no secrets
(no account API key, no `recovery_credential`, no webhook signing secret,
no PayBox credential, no raw payment authorization).

## In the app

The same flow is available in `onchaindiligence-app` without any `curl`:
**Operation history** tab (connect/create an account, browse, open an
operation, "View investigation" -> "Export JSON" / "Copy investigation
summary") and **Webhooks** tab (add an endpoint, see delivery history).
