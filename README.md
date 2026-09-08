# OnChainDiligence — MCP Server

**Accountability infrastructure for consequential autonomous actions.**
Payments are our first consequential action, not our definition of one.

Current wedge: **agent commerce / payments.**

> Know why your agent paid — and verify what happened afterward.
> Keep your wallet. Keep your payment provider. Add OCD once.

Core primitive: an **OCD Action Receipt**, backed by an **Agent Evidence
graph** — Mandate → Evidence → Policy → Decision → Execution →
Observation/Reconciliation → Verifiable Receipt. Sanctions/company checks
(Chainalysis, UK Companies House, SEC EDGAR) still exist and are fully
supported, but they are **Evidence Providers** — supporting capabilities the
lifecycle can call on, not what the company is primarily about.

This repo is the **MCP server** — `mcp.onchaindiligence.com` — one of three
rails ([HTTP API](https://api.onchaindiligence.com), Bazaar x402 routes, MCP)
that all produce the same signed evidence. Part of
[onchaindiligence.com](https://onchaindiligence.com).

---

## 1. What OnChainDiligence is now

The original thesis: consequential autonomous actions should leave behind
evidence that can be independently verified later. The current product wedge
is agent commerce — an agent proposing, executing, and settling a payment —
because that's where the evidence problem is sharpest and most valuable
today. The same evidence graph (mandate, evidence, policy, decision,
execution, independent observation) generalizes beyond payments; payments
are the first profile it's built for, not a permanent ceiling.

OCD is **not** the wallet, the executor, or the payment provider. It never
holds funds, never signs a payment, and never overrides your own
wallet/provider's authorization. It evaluates proposed payments against your
policy, independently observes what actually settled, and issues a signed,
independently verifiable receipt reconciling the two.

## 2. Agent payment lifecycle

```
Mandate/Intent → Evidence → Policy → Decision → Execution → Observation/Reconciliation → Verifiable Receipt

  inspect_payment (free, deterministic sanity-check)
        │
        ▼
  preflight_payment ($0.01) ──► PREFLIGHT receipt (ALLOW / REQUIRE_APPROVAL / BLOCK)
        │                         + one-time finalization capability
        ▼
  your own wallet/executor authorizes and submits the payment
        │                         (OCD never holds a key or signs)
        ▼
  OCD independently observes settlement on-chain
        │
        ▼
  finalize (free, using the capability) ──► Commerce Receipt
                                             (execution + settlement, reconciled)
```

Full write-up: [`docs/PAYMENT_PREFLIGHT.md`](docs/PAYMENT_PREFLIGHT.md) and
[`docs/COMMERCE_RECEIPTS.md`](docs/COMMERCE_RECEIPTS.md).

## 3. Public/free verification MCP

**`https://mcp.onchaindiligence.com/public/mcp`** — a separate, free,
unauthenticated MCP surface, deliberately non-transactional. Three tools:

| Tool | What it does |
|---|---|
| `inspect_payment` | Deterministic policy comparison only — ALLOW / REQUIRE_APPROVAL / BLOCK. No external lookups, signing, storage, or receipt. |
| `get_receipt` | Retrieve a public, signed OCD receipt by its exact `receipt_id`. |
| `verify_receipt` | Check a receipt's proof — VALID, INVALID, or UNVERIFIABLE. |

This surface **cannot** send payments, custody funds, authorize a wallet,
reach private operations, or call the paid x402 tools below — it only
inspects and verifies. No account, API key, or credential of any kind is
needed or accepted.

**Live, validated Claude custom connector.** Add it in Claude at
**Settings/Customize → Connectors → Add custom connector**, paste
`https://mcp.onchaindiligence.com/public/mcp`, name it `OnChainDiligence`,
leave authentication as **None** (transport is Streamable HTTP). It has been
exercised through a real Claude host loop — tool discovery, tool selection,
and correct interpretation of VALID/receipt content all confirmed. The same
URL works with any Streamable HTTP MCP client, including ChatGPT's custom
connector setup, using the same steps.

Try it against a real example receipt:
[`OCD-RCP-NB51-QG4S-VCAN-Y57F`](https://onchaindiligence.com/r/OCD-RCP-NB51-QG4S-VCAN-Y57F).

## 4. Paid x402 MCP / Evidence-Provider tools

**`https://mcp.onchaindiligence.com/mcp`** — the paid surface, billed
per-call in USDC on Base via [x402](https://x402.org). `tools/list` returns
**nine** tools today: six priced Evidence-Provider/commerce tools, plus the
same three free tools from section 3 (also available here for convenience).

| Tool | Description | Price |
|------|-------------|-------|
| `preflight_payment` | Evaluate a proposed payment against policy; issues a signed PREFLIGHT receipt + finalization capability. | $0.01 |
| `screen_wallet` | Screen a wallet address against the Chainalysis on-chain sanctions oracle (US/EU/UN lists). | $0.01 |
| `screen_name` | Fuzzy-match a person or company against OFAC SDN names and strong aliases. | $0.02 |
| `verify_uk_company` | UK company lookup: status, type, incorporation, registered address, people with significant control. | $0.05 |
| `verify_us_company` | Resolve a public US company through SEC EDGAR. | $0.05 |
| `diligence` | Run wallet and UK-company checks in parallel, without claiming a verified link between them. | $0.05 |
| `inspect_payment`, `get_receipt`, `verify_receipt` | Same as section 3 — free, no payment required, also reachable here. | free |

Payment mechanics (unpaid call → x402 requirement → agent policy + wallet
authorization → paid retry → signed result) are unchanged from before — see
[§ How payment works](#how-payment-works) below.

*(This corrects [issue #4](https://github.com/Qazza1/onchaindiligence-mcp/issues/4): the README previously said "five tools" and didn't mention `preflight_payment`, `inspect_payment`, `get_receipt`, or `verify_receipt`, or that the last three are free.)*

## 5. Commerce SDK

For a TypeScript application (as opposed to an MCP-connected chat agent),
[`@onchaindiligence/sdk/commerce`](https://github.com/Qazza1/onchaindiligence-sdk)
orchestrates the full lifecycle in-process — open → preflight → execute →
observe/finalize — with the recovery guarantees above built in, rather than
hand-rolling the MCP/x402 sequence:

```ts
import { createCommerceClient, apiPurchasePolicy } from '@onchaindiligence/sdk/commerce'
import { NodeFileRecoveryStore } from '@onchaindiligence/sdk/commerce/node'

const ocd = createCommerceClient({ recovery: new NodeFileRecoveryStore('./ocd-recovery') })
const { policy } = apiPurchasePolicy({ maxAmount: '1.00', allowedNetwork: 'eip155:8453', allowedAsset: BASE_USDC })

const op = await ocd.open({ action: proposedPayment, policy })
const evaluation = await op.preflight()
if (evaluation.kind !== 'allowed') return handleThat(evaluation)

const execution = await op.execute({ executor: myExecutor }) // your wallet/provider does the signing
const result = await op.observeAndFinalize() // safe to retry while kind === 'pending'
```

See the SDK repo's README for the full executor list (`X402BaseUsdcExecutor`,
`PayBoxCommerceExecutor`, `MockCommerceExecutor`) and the still-supported
Evidence Provider client (`screen`, `screenName`, `verifyCompany`,
`diligence`) — the SDK covers both.

## 6. Receipts and verification

Every preflight and commerce receipt is a signed, content-addressed
`OCD-RCP-XXXX-XXXX-XXXX-XXXX` object. Retrieve one for free with `get_receipt`
(or `GET /receipts/:receiptId`); check it with `verify_receipt` (or the
[public verifier](https://onchaindiligence.com/verify)) to get back
**VALID / INVALID / UNVERIFIABLE**.

- **Online verification** (`verify_receipt`) is a convenience: it fetches
  OCD's own public key registry and trusts this server to have checked
  honestly.
- **Offline verification** is strictly stronger — run the same check
  yourself against the published
  [`@onchaindiligence/agent-evidence`](https://github.com/Qazza1/onchaindiligence)
  package and your own copy of the key registry.

See section 10 for exactly what VALID does and doesn't mean.

## 7. Current integrations: ChatGPT and Claude

Both are ordinary Streamable HTTP MCP clients — no special-casing on this
server's side. Point either at the free `/public/mcp` endpoint (section 3)
for read-only inspection/verification, or the paid `/mcp` endpoint (section
4) for the full Evidence-Provider/commerce tool set.

- **Claude** — add as a custom connector (see section 3). This has been
  validated through a real Claude host loop: correct tool discovery, correct
  tool selection, and correct interpretation of receipt content and VALID's
  actual scope.
- **ChatGPT** — register the same URL as a custom MCP connector; ChatGPT
  calls `tools/list` and `tools/call` exactly like any other client.
- **Gemini / a custom agent tool loop** — any Streamable HTTP MCP client
  works unmodified; see [`test/client.ts`](./test/client.ts) for the exact
  wire format.

Neither integration implies a formal app-store/directory listing beyond what
each platform's own directory pages state independently of this README.

**The application layer that decides whether to act on a tool's result is
the real enforcement boundary — "the model remembered to call OCD" is never
a substitute for that.**

## 8. Evidence Providers

Supporting capabilities the lifecycle (or a caller directly) can draw
evidence from — not the company's primary description:

- **Chainalysis on-chain sanctions oracle** — a free, public smart contract
  on Ethereum mainnet (`0x40C57923924B5c5c5455c48D93317139ADDaC8fb`), queried
  read-only via [viem](https://viem.sh). No Chainalysis API key or
  commercial relationship required; it's a public good reflecting US/EU/UN
  sanctions lists. The per-call fee covers infrastructure, not the data.
- **OFAC SDN name screening** — fuzzy match against primary names and strong
  aliases only; weak AKAs are not screened, per OFAC guidance.
- **UK Companies House** — official register lookup: status, type,
  incorporation, registered office, people with significant control.
- **SEC EDGAR** — public US company/fund resolution by ticker, CIK, or name.

These checks use the same underlying public-data sources as the
[HTTP API](https://api.onchaindiligence.com) — separate deployments, so
response-level equivalence is enforced by contract tests, not assumed.

## 9. Architecture

```
agent (MCP client + x402 wallet, or Claude/ChatGPT as a custom connector)
      │  Streamable HTTP
      ▼
index.ts ──────────────── Hono app; routes /mcp and /public/mcp
      │
      ├── src/server.ts ────── paid handler: preflight_payment + 5 Evidence-
      │                        Provider tools (x402-gated) + the same 3 free
      │                        tools registered again for convenience
      │
      ├── src/publicMcp.ts ─── free handler: inspect_payment, get_receipt,
      │                        verify_receipt only. Never imports or
      │                        delegates to the paid handler.
      │
      ├── src/preflight.ts ──── deterministic policy evaluation
      ├── src/receiptTools.ts ─ get_receipt / verify_receipt primitives,
      │                         shared by both handlers and the free HTTP
      │                         route (receiptsRoute.ts)
      ├── src/chainalysis.ts ── sanctions oracle read (viem, Ethereum mainnet)
      └── src/companiesHouse.ts ─ UK Companies House lookup
```

## 10. Security / claim limitations

- **VALID means cryptographic integrity and authenticity of the receipt
  under the verifier contract — not universal truth of every claim inside
  it**, and not proof the underlying action succeeded.
- **An OCD `ALLOW` is a policy comparison, not wallet authorization.** Your
  own wallet/provider always makes the actual authorization decision.
- **Settlement does not prove service/merchant delivery.** OCD independently
  observes that value moved; it does not independently verify that whatever
  was purchased was actually delivered.
- **Caller-reported merchant evidence stays labeled as caller-reported** —
  it is never silently upgraded to independently-observed evidence.
- OCD is **not** a fraud detector and **not** a compliance guarantee. Its
  checks are evidence-based tooling; using it does not by itself satisfy any
  specific law, regulation, or compliance regime.
- OCD does not claim a partnership, endorsement, or affiliation with any
  executor, wallet provider, or platform beyond what that party has stated
  independently.
- **UNKNOWN and UNVERIFIED are preserved, never quietly resolved.** A
  receipt that can't confirm something says so rather than defaulting to a
  clean-looking result.

Found a vulnerability? Report it to **security@onchaindiligence.com**. See
[onchaindiligence.com/.well-known/security.txt](https://onchaindiligence.com/.well-known/security.txt).

---

## How payment works

Payment rides on [x402](https://x402.org), the open agent-payment standard
built on HTTP `402 Payment Required`:

1. The agent calls a tool with no payment attached.
2. The server returns the payment requirements (amount, asset, recipient, network).
3. The agent signs a USDC payment authorization from its own wallet.
4. The agent retries the call with the payment in the tool-call `_meta`.
5. The server verifies and settles via the Coinbase facilitator, runs the check, and returns the result.

The flow is **non-custodial**: USDC moves directly from the agent's wallet to
the recipient. This server never holds funds and runs no billing system —
deliberate, given the product is about *not* being a trusted intermediary.

```ts
const client = await connectMcp('https://mcp.onchaindiligence.com/mcp')
const { tools } = await client.listTools()

const unpaid = await client.callTool({
  name: 'screen_wallet',
  arguments: { address: '0x0000000000000000000000000000000000000000' },
})
const requirement = unpaid.structuredContent.accepts[0]
// requirement contains the exact amount, USDC asset, Base network and recipient.

const payment = await createPaymentHeader(agentWallet, 1, requirement)
const paid = await client.callTool({
  name: 'screen_wallet',
  arguments: { address: '0x0000000000000000000000000000000000000000' },
  _meta: { 'x402/payment': payment },
})
```

The runnable [`test/client.ts`](./test/client.ts) performs that exact
sequence with `MCP_SERVER_URL` and `PAYER_PRIVATE_KEY` environment-variable
placeholders; it never embeds a wallet key in source. Always read the current
price from the unpaid response rather than hard-coding it.

## Two payment rails by design

OnChainDiligence settles two ways, because the agent-payment landscape is
split between two standards:

| | HTTP API | MCP server (this repo) |
|---|---|---|
| Protocol | Machine Payments Protocol (Stripe/Tempo) | x402 (Coinbase/Base) |
| Chain | Tempo | Base mainnet |
| Currency | pathUSD | USDC |
| Settlement | session-based | per-call, on-chain |

Same checks, same signed results, different rails for different ecosystems.

## Standard HTTP x402 surface

Alongside the MCP transport, every Evidence Provider check is also available
to a generic x402 buyer over plain HTTPS, using the x402 **v2** stack
(CAIP-2 networks, HTTP 402, `X-PAYMENT` header):

| Resource | Price |
|---|---|
| `GET /x402/screen/:address` | $0.01 |
| `GET /x402/screen-name?name=` | $0.02 |
| `GET /x402/uk-company/:companyNumber` | $0.05 |
| `GET /x402/us-company?q=` | $0.05 |
| `GET /x402/diligence?wallet=&company=` | $0.05 |
| `GET /x402/verdict/:address` | $0.01 |

Free discovery documents: [`/openapi.json`](https://mcp.onchaindiligence.com/openapi.json)
and [`/.well-known/x402`](https://mcp.onchaindiligence.com/.well-known/x402).

Buyer walkthrough: [`docs/X402_HTTP_BUYERS.md`](docs/X402_HTTP_BUYERS.md).
Why the MCP rail is still on x402 v1, and what migrating it would require:
[`docs/MCP_X402_MIGRATION.md`](docs/MCP_X402_MIGRATION.md).

## Design notes

A few decisions worth explaining, since they reflect real constraints rather
than preference:

- **Why Base and not Tempo.** The HTTP API settles on Tempo, so unifying on
  one chain would have been cleaner. But the `x402-mcp` package hardcodes its
  network type to `"base" | "base-sepolia"` — Tempo is not a permitted value.
  Rather than fork the package or write a custom facilitator, this server
  settles on Base, and OnChainDiligence accepts two rails. The constraint is
  documented, not papered over.
- **The test client is hand-rolled.** `x402-mcp` ships a `withPayment`
  helper, but it imports an MCP client API (`experimental_MCPClient`) that
  the `ai` SDK removed in v5. Rather than pin an old `ai` version,
  `test/client.ts` performs the x402 loop directly on the MCP SDK plus
  `x402/client`. The server itself doesn't depend on `ai`, so this is a
  test-only concern.
- **Public-data clients are currently duplicated.** `chainalysis.ts` and
  `companiesHouse.ts` began as copies of the HTTP API implementations. They
  can drift, so the remediation roadmap moves them behind a shared
  service/package and adds contract tests.

## Running locally

Requires Node 22+.

```bash
npm install
cp .env.example .env   # fill in the values below
npm run dev            # serves http://localhost:3000/mcp and /public/mcp
```

Environment variables:

| Variable | Purpose |
|----------|---------|
| `COMPANIES_HOUSE_API_KEY` | UK Companies House API key (free). |
| `SANCTIONS_ORACLE_RPC_URL` | Ethereum RPC for the oracle read. |
| `X402_RECIPIENT_ADDRESS` | Base address that receives USDC. |
| `X402_NETWORK` | `base-sepolia` (testnet) or `base` (mainnet). |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Coinbase Developer Platform keys for the x402 facilitator. |
| `ATTESTATION_SERVICE_TOKEN` | Server-to-server credential for the API's internal attestation service. Required for signed results; never expose it to browser code. |

To exercise the full paid loop against the running server:

```bash
# in .env, also set PAYER_PRIVATE_KEY to a wallet funded with testnet USDC + ETH
npm run test:client
```

## License

MIT — see [LICENSE](./LICENSE).
