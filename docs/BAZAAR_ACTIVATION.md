# Bazaar Activation Runbook (D2.10A)

Status: **preparation only — no settlement has been made as part of this
task.** This documents the ALREADY-BUILT Bazaar/x402 discovery
implementation (`src/discovery.ts`) and the exact checklist to run
**after** the D2.6 live reference passes. Nothing here rebuilds or
modifies Bazaar support.

## What "Bazaar-enabled" means here

`src/discovery.ts` registers 8 routes with `@x402/hono`'s
`paymentMiddleware`, each carrying a `declareDiscoveryExtension()` block
(`@x402/extensions/bazaar`) in its `extensions` field. That extension
block — an example `output` + JSON `schema` — is what the CDP Facilitator
reads and indexes into Bazaar's discovery catalog **after the first
successful settlement against that exact route**. It is a completely
separate mechanism from the `/mcp` MCP tool surface, which uses
`x402-mcp` and is untouched by this file (see the file's own header:
"if the Bazaar experiment goes nowhere, delete this file and the three
lines in index.ts and the server is exactly as it was").

## Bazaar-enabled routes and prices

All prices come from `src/config.ts`'s `config.prices` (the SAME object
the MCP tools use — one price definition, never duplicated):

| Route | Price | Discovery description constant |
|---|---|---|
| `GET /x402/screen/:address` | $0.01 (`prices.screen`) | `DESCRIPTION` |
| `GET /x402/us-company` | $0.05 (`prices.usCompany`) | `US_COMPANY_DESCRIPTION` |
| `GET /x402/verdict/:address` | $0.01 (`prices.screen`) | `VERDICT_DESCRIPTION` |
| `GET /x402/screen-name` | $0.02 (`prices.nameScreen`) | `SCREEN_NAME_DESCRIPTION` |
| `GET /x402/uk-company/:companyNumber` | $0.05 (`prices.company`) | `UK_COMPANY_DESCRIPTION` |
| `GET /x402/diligence` | $0.05 (`prices.diligence`) | `DILIGENCE_DESCRIPTION` |
| `POST /x402/preflight-payment` | $0.01 (`prices.preflight`) | (inline description) |
| `POST /x402/lifecycle/preflight-payment` | $0.01 (`prices.preflight`) | (inline description) |

Every description constant is written to stay under
`MAX_X402_DESCRIPTION_LENGTH = 480` chars — the CDP hosted facilitator's
real `/verify` rejects any `resource.description` over 500 chars
(confirmed live incident, see `discovery.ts`'s own comment and
`test/x402Routes.ts`'s regression test). `NOT` Bazaar-enabled: the free
`inspect_payment`/`GET /inspect/payment` route, and everything under
`/mcp` (a different transport, `x402-mcp`, not this discovery-extension
mechanism).

## Network configuration

- `CAIP2` (`src/discovery.ts`) = `eip155:8453` (Base mainnet) when
  `X402_DISCOVERY_NETWORK` (or, if unset, `X402_NETWORK`) is `"base"`;
  otherwise `eip155:84532` (Base Sepolia).
- `X402_DISCOVERY_NETWORK` is a **separate, optional** env var from
  `X402_NETWORK` — it exists specifically so the Bazaar beacon can sit on
  free Base Sepolia for a trigger settle while the live `/mcp` server
  stays on Base mainnet, without touching production. Not currently set
  in `.env.example` (defaults to whatever `X402_NETWORK` is — currently
  `base-sepolia` in the example file; **production is Base mainnet**, per
  the live D2.6 OneSource reference).
- `X402_RECIPIENT_ADDRESS` — the `payTo` address on every Bazaar route.
  Same address used everywhere else in this server (`config.x402.recipient`).

## Facilitator

CDP's hosted facilitator, via `@coinbase/x402`'s `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`
→ `HTTPFacilitatorClient` → `x402ResourceServer` registered with
`ExactEvmScheme()` for the CAIP-2 network above. Same credentials the
`/mcp` handler already uses — nothing separate to provision.

## What exactly triggers indexing

**A successful settlement against one of OCD's own Bazaar-enabled seller
routes above, through the CDP facilitator.** Nothing else does. In
particular:

- **The D2.6 OneSource live reference does NOT activate this.** In that
  flow, OCD (via PayBox) is the **buyer**, paying a third-party merchant
  (OneSource). Bazaar indexing only reacts to settlements where the CDP
  facilitator verifies/settles a payment **to** one of these
  `declareDiscoveryExtension()`-carrying routes — i.e., OCD must be the
  **seller** in the triggering transaction.
- A local/offline test (`test/x402Routes.ts`) never touches the real
  facilitator and cannot trigger indexing.
- The two local scripts already sitting in this repo's working tree
  (`trigger-settle.ts`, `settle-verdict.mjs`) are exactly this: a real,
  self-paid $0.01 settlement against `GET /x402/screen/:address` or
  `GET /x402/verdict/:address` on the **live production URL**
  (`https://mcp.onchaindiligence.com`), paying to OCD's own configured
  recipient (net cost ≈ Base gas only). **Neither was run as part of this
  task** — their presence is prior exploration, not confirmation of
  execution. Whichever is used, it needs `BUYER_PRIVATE_KEY` /
  `PAYER_PRIVATE_KEY` (a funded EVM key) set as a local env var, never
  pasted into chat.

## Post-D2.6 checklist (do not run yet)

1. Confirm `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` are the production
   credentials and `X402_RECIPIENT_ADDRESS` is the correct live recipient.
2. Decide network: trigger on Base Sepolia first via
   `X402_DISCOVERY_NETWORK=base-sepolia` (free testnet USDC) to prove the
   mechanism, OR go straight to Base mainnet (real, tiny, self-paid cost)
   since production is already on mainnet. Either requires a real
   settlement — pick based on how much you want to rehearse before the
   one that actually needs to count (mainnet).
3. Run **one** real settlement against a Bazaar-enabled route (e.g.
   `settle-verdict.mjs` against `GET /x402/verdict/:address`, or
   `trigger-settle.ts` against `GET /x402/screen/:address`) using a
   funded key, paying OCD's own recipient.
4. Confirm the settlement actually succeeded (HTTP 200, a real
   `x-payment-response`/settlement header, a valid signed attestation
   envelope in the body) before assuming indexing happened.
5. Wait for CDP to index (not instantaneous; no documented SLA observed
   here — check again after a few minutes).

## Verifying the route appears in Bazaar afterward

Query CDP's public discovery API directly (used by the repo's own
`scan_bazaar.py` exploration script):

```
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=500&offset=0
```

Paginate via `limit`/`offset` against the response's
`pagination.total` until every item has been scanned, and look for an
item whose JSON contains OCD's recipient address
(`X402_RECIPIENT_ADDRESS`, lowercased) or `onchaindiligence` in its
resource/description text. No API key required for this read.

## Metadata to inspect once indexed

- The exact `resource` URL Bazaar recorded (must match the live route,
  including network) — confirm it's `mcp.onchaindiligence.com`, not a
  staging/preview URL.
- `accepts` block: price, network (CAIP-2), `payTo` — confirm they match
  `config.prices`/`X402_RECIPIENT_ADDRESS` exactly.
- The `extensions` discovery block: confirm the `output.example`/`schema`
  rendered matches what `declareDiscoveryExtension()` actually declared
  for that route (no truncation from the 480-char description budget
  spilling into the schema).
- Whether OTHER Bazaar-enabled routes (all 8 above) also appear, or only
  the one actually settled — indexing is per-route, not per-server; each
  additional route likely needs its own settlement to appear.
