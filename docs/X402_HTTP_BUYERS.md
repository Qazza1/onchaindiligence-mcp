# Buying OnChainDiligence checks over standard HTTP x402

This is the **standard x402 v2 HTTP surface, intended for PayBox testing** and
for any other generic x402 buyer. It is deliberately not described as
"PayBox-compatible": protocol-level compatibility has not been confirmed
end to end against PayBox yet (see [Status](#status)).

There are two independent payment rails in front of the same checks:

| | `POST /mcp` | `GET /x402/*` |
|---|---|---|
| Protocol | MCP Streamable HTTP (JSON-RPC) | plain HTTPS |
| x402 version | v1 (`x402-mcp`) | **v2** |
| Unpaid response | HTTP **200** with an `isError` tool result | HTTP **402** |
| Where the quote lives | `structuredContent.accepts` | `Payment-Required` header |
| Where payment goes | `_meta["x402/payment"]` | `X-PAYMENT` header |
| Network id | `base` | `eip155:8453` (CAIP-2) |
| Resource id | `mcp://tool/screen_wallet` | a real HTTPS URL |

A generic HTTP x402 buyer should use the `/x402/*` rail. The MCP rail is for
MCP clients that already speak `x402-mcp`.

## The flow

```
buyer                                   mcp.onchaindiligence.com
  |                                                |
  |  GET /x402/screen/0xabc...                     |
  |----------------------------------------------->|
  |                                                |  input validated first:
  |                                                |  malformed -> 400, never charged
  |  402 Payment Required                          |
  |  Payment-Required: <base64 JSON>               |
  |<-----------------------------------------------|
  |                                                |
  |  decode the header ->                          |
  |    { x402Version: 2,                           |
  |      accepts: [{ scheme: "exact",              |
  |                  network: "eip155:8453",       |
  |                  amount: "10000",              |
  |                  asset: "<USDC on Base>",      |
  |                  payTo: "<OCD recipient>" }] } |
  |                                                |
  |  authorise the payment (EIP-3009)              |
  |  build the X-PAYMENT header                    |
  |                                                |
  |  GET /x402/screen/0xabc...                     |
  |  X-PAYMENT: <payment payload>                  |
  |----------------------------------------------->|
  |                                                |  facilitator verifies + settles
  |                                                |  then the check runs
  |  200 OK                                        |
  |  { "data": {...}, "attestation": {...} }       |
  |<-----------------------------------------------|
  |                                                |
  |  verify the Ed25519 attestation independently  |
  |  at onchaindiligence.com/verify                |
```

Payment is **non-custodial**: a facilitator verifies and settles the payment to
our recipient address before a paid handler runs. OnChainDiligence never holds
buyer funds.

## Discovery

- `GET /openapi.json` — OpenAPI 3.1 for every paid resource. Free.
- `GET /.well-known/x402` — capability manifest. Free. Compatibility/discovery
  metadata following the envelope in the IETF Internet-Draft
  `draft-hawkins-x402-dns-discovery` (`{ x402Version, kind, resources[] }`).
  That is an **active draft, not a ratified standard**, and this file is served
  for crawlers that look for it — not as a claim of standards compliance.
- The x402 Bazaar. Each paid route declares the Bazaar discovery extension
  inside its 402 challenge. CDP indexes a resource after the facilitator
  settles a payment for it, so the routes are **discovery-ready but not yet
  indexed** until the first settle (`scripts/activate-x402.ts`).

## Resources and prices

| Resource | Price | What it answers |
|---|---|---|
| `GET /x402/screen/:address` | $0.01 | Is this EVM wallet on a sanctions list? |
| `GET /x402/screen-name?name=` | $0.02 | Does this person/company name match the OFAC SDN list? |
| `GET /x402/uk-company/:companyNumber` | $0.05 | Is this UK company real, active, and who controls it? |
| `GET /x402/us-company?q=` | $0.05 | Is this US public company registered with the SEC? |
| `GET /x402/diligence?wallet=&company=` | $0.05 | Both a wallet screen and a UK company check, independently. |
| `GET /x402/verdict/:address` | $0.01 | One PASS / WARN / BLOCK counterparty verdict. |

Prices come from a single canonical source (`config.prices`) shared with the
MCP tools, so the two rails cannot drift apart.

### What these results do and do not mean

- A **signed attestation** proves the result came from OnChainDiligence
  unaltered. It does not make the underlying claim objectively true.
- **Name screening** returns candidate matches to investigate against secondary
  identifiers, not a determination. Weak aliases are not screened.
- **`diligence` runs two independent checks.** It does **not** establish that
  the wallet belongs to, or is controlled by, the company.
- **`us-company`** covers SEC-registered public companies only, not private US
  companies.

## Invalid input is never charged

Every route validates its input *before* the payment middleware issues a
challenge. A malformed address, company number or missing parameter returns
HTTP 400 with no `Payment-Required` header, so a buyer is never charged for a
request that could not have succeeded.

## Status

Confirmed by inspection and live probing:

- the `/x402/*` routes serve genuine x402 **v2** challenges on Base mainnet;
- the quoted scheme/network/asset/recipient/amount match this document;
- PayBox's `pay_x402` returns an `X-PAYMENT` header to replay and its
  `use_service` performs a plain HTTP fetch — both of which fit this rail and
  neither of which fits the MCP rail.

**Not yet confirmed:** that PayBox's server-side payment builder accepts a v2
CAIP-2 `accepts` entry (its `accepts` argument is an untyped passthrough and
its version handling is not publicly documented). Until a real PayBox call
succeeds against these routes, this remains a *standard x402 v2 HTTP surface
intended for PayBox testing*, not a claim of PayBox compatibility.
