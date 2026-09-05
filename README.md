# OnchainDiligence — MCP Server

A paid, non-custodial **Model Context Protocol** server that exposes on-chain compliance checks as tools AI agents can discover and pay for autonomously. Sanctions screening and UK company verification, billed per call in **USDC on Base** via the [x402](https://x402.org) protocol — no API keys, no accounts, no subscriptions.

Live at **`https://mcp.onchaindiligence.com/mcp`** · Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=onchaindiligence) as `com.onchaindiligence/compliance` · Part of [onchaindiligence.com](https://onchaindiligence.com).

---

## What it does

An agent connects over Streamable HTTP and finds five tools:

| Tool | Description | Price |
|------|-------------|-------|
| `screen_wallet` | Screen a wallet address against the Chainalysis on-chain sanctions oracle (US/EU/UN lists). | $0.01 |
| `screen_name` | Fuzzy-match a person or company against OFAC SDN names and strong aliases. | $0.02 |
| `verify_uk_company` | Look up a UK company by registration number: status, type, incorporation, registered address, and people with significant control. | $0.05 |
| `verify_us_company` | Resolve a public US company through SEC EDGAR. | $0.05 |
| `diligence` | Run wallet and UK-company checks in parallel, without claiming a verified link between them. | $0.05 |

The tools use the same underlying public-data sources as the [HTTP API](https://api.onchaindiligence.com). They are separate deployments, so response-level equivalence must be enforced by contract tests rather than assumed.

## Use OnChainDiligence from an agent

Connect a Streamable HTTP MCP client to `https://mcp.onchaindiligence.com/mcp`.
The useful path is deliberately explicit:

```text
agent → tools/list → choose a tool → unpaid tool call → x402 requirement
      → agent policy + wallet authorization → paid retry → signed result
```

For a minimal `screen_wallet` consumer, first discover the server's current
tool schema and call it without payment:

```ts
const client = await connectMcp('https://mcp.onchaindiligence.com/mcp')
const { tools } = await client.listTools()

const unpaid = await client.callTool({
  name: 'screen_wallet',
  arguments: { address: '0x0000000000000000000000000000000000000000' },
})
const requirement = unpaid.structuredContent.accepts[0]
// requirement contains the exact amount, USDC asset, Base network and recipient.

// Only after the caller's policy approves the server-supplied requirement:
const payment = await createPaymentHeader(agentWallet, 1, requirement)
const paid = await client.callTool({
  name: 'screen_wallet',
  arguments: { address: '0x0000000000000000000000000000000000000000' },
  _meta: { 'x402/payment': payment },
})
```

The runnable [`test/client.ts`](./test/client.ts) performs that exact sequence
with `MCP_SERVER_URL` and `PAYER_PRIVATE_KEY` environment-variable placeholders;
it never embeds a wallet key in source.

The live service returned `10000` atomic USDC units ($0.01) for
`screen_wallet` during validation on 2026-09-03. That is only an observation:
agents must always read the current requirement from the unpaid response rather
than hard-coding a price.

### Connecting specific MCP clients

Every client below speaks the same standard MCP protocol to the same server
(`https://mcp.onchaindiligence.com/mcp`) — these are setup/configuration
differences, not separate implementations. **The application layer that
decides whether to act on a tool's result is the real enforcement boundary —
"the model remembered to call OCD" is never a substitute for that.**

- **Claude Desktop / Claude Code** — add an entry under `mcpServers` in your
  MCP config (Claude Code: `claude mcp add`, or edit the config file directly):
  ```json
  { "mcpServers": { "onchaindiligence": { "url": "https://mcp.onchaindiligence.com/mcp" } } }
  ```
- **ChatGPT (custom connector / Apps SDK)** — register the same URL as an MCP
  connector in the connector/app configuration UI; ChatGPT calls `tools/list`
  and `tools/call` exactly like any other client.
- **Gemini / a custom agent tool loop** — any client speaking Streamable HTTP
  MCP (`tools/list`, `tools/call`, x402 `_meta` payment) works unmodified; see
  the sequence above and [`test/client.ts`](./test/client.ts) for the exact
  wire format.

For a TypeScript application (not an MCP-connected chat agent), prefer the
[`@onchaindiligence/sdk/commerce`](https://github.com/Qazza1/onchaindiligence-sdk)
client over hand-rolling the MCP/x402 sequence — it orchestrates
open → preflight → execute → observe/finalize with the D2.4 recovery
guarantees built in.

## How payment works

Payment rides on [x402](https://x402.org), the open agent-payment standard built on HTTP `402 Payment Required`:

1. The agent calls a tool with no payment attached.
2. The server returns the payment requirements (amount, asset, recipient, network).
3. The agent signs a USDC payment authorization from its own wallet.
4. The agent retries the call with the payment in the tool-call `_meta`.
5. The server verifies and settles via the Coinbase facilitator, runs the check, and returns the result.

The flow is **non-custodial**: USDC moves directly from the agent's wallet to the recipient. This server never holds funds and runs no billing system — which is deliberate, given the product is about *not* being a trusted intermediary.

## Two payment rails by design

OnchainDiligence settles two ways, because the agent-payment landscape is split between two standards:

| | HTTP API | MCP server (this repo) |
|---|---|---|
| Protocol | Machine Payments Protocol (Stripe/Tempo) | x402 (Coinbase/Base) |
| Chain | Tempo | Base mainnet |
| Currency | pathUSD | USDC |
| Settlement | session-based | per-call, on-chain |

Same checks, same signed results, different rails for different ecosystems.

## Standard HTTP x402 surface

Alongside the MCP transport, every check is also available to a generic x402
buyer over plain HTTPS, using the x402 **v2** stack (CAIP-2 networks, HTTP 402,
`X-PAYMENT` header):

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

## Architecture

```
agent (MCP client + x402 wallet)
      │  Streamable HTTP
      ▼
index.ts ──────────── Hono app, routes /mcp to the handler
      ▼
src/server.ts ─────── createPaidMcpHandler: 5 paidTools, x402 gating
      │
      ├── src/chainalysis.ts ──── sanctions oracle read (viem, Ethereum mainnet)
      └── src/companiesHouse.ts ─ UK Companies House lookup
```

- **`src/server.ts`** — defines the five `paidTool`s with their prices and Zod schemas, wired to the Coinbase facilitator for x402 settlement.
- **`src/chainalysis.ts` / `src/companiesHouse.ts`** — the check logic, reused unchanged from the HTTP API so results stay consistent across rails.
- **`index.ts`** — a Hono app exposing the handler at `/mcp`; deployed as a Vercel function, and the same app is served locally by `src/local.ts`.
- **`test/client.ts`** — a low-level test client that performs the full x402 pay-and-retry loop by hand (see *Design notes*).

### Sanctions data

Screening reads the **Chainalysis on-chain sanctions oracle** — a free, public smart contract on Ethereum mainnet (`0x40C57923924B5c5c5455c48D93317139ADDaC8fb`), queried with a read-only `isSanctioned()` call via [viem](https://viem.sh). No Chainalysis API key or commercial relationship is required; the oracle is a public good reflecting US/EU/UN sanctions lists. The per-call fee covers infrastructure, not the data.

## Running locally

Requires Node 22+.

```bash
npm install
cp .env.example .env   # fill in the values below
npm run dev            # serves http://localhost:3000/mcp
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

## Design notes

A few decisions worth explaining, since they reflect real constraints rather than preference:

- **Why Base and not Tempo.** The HTTP API settles on Tempo, so unifying on one chain would have been cleaner. But the `x402-mcp` package hardcodes its network type to `"base" | "base-sepolia"` — Tempo is not a permitted value. Rather than fork the package or write a custom facilitator, this server settles on Base, and OnchainDiligence accepts two rails. The constraint is documented, not papered over.

- **The test client is hand-rolled.** `x402-mcp` ships a `withPayment` helper, but it imports an MCP client API (`experimental_MCPClient`) that the `ai` SDK removed in v5. Rather than pin an old `ai` version, `test/client.ts` performs the x402 loop directly on the MCP SDK plus `x402/client` — calling unpaid to get requirements, building a payment header, and retrying with payment in `_meta`. The server itself doesn't depend on `ai`, so this is a test-only concern.

- **Public-data clients are currently duplicated.** `chainalysis.ts` and `companiesHouse.ts` began as copies of the HTTP API implementations. They can drift, so the remediation roadmap moves them behind a shared service/package and adds contract tests.

## Not a compliance program

OnchainDiligence returns factual checks and signed attestations. It is **not** legal or compliance advice and is not a substitute for a full compliance program. The sanctions oracle returns a match flag, not rich case detail. Results are never cached.

## Security

Found a vulnerability? Please report it to **security@onchaindiligence.com**. Responsible disclosure is appreciated. See [onchaindiligence.com/.well-known/security.txt](https://onchaindiligence.com/.well-known/security.txt).

## License

MIT — see [LICENSE](./LICENSE).
