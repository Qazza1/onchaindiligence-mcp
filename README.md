# OnchainDiligence — MCP Server

A paid, non-custodial **Model Context Protocol** server that exposes on-chain compliance checks as tools AI agents can discover and pay for autonomously. Sanctions screening and UK company verification, billed per call in **USDC on Base** via the [x402](https://x402.org) protocol — no API keys, no accounts, no subscriptions.

Live at **`https://mcp.onchaindiligence.com/mcp`** · Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=onchaindiligence) as `com.onchaindiligence/compliance` · Part of [onchaindiligence.com](https://onchaindiligence.com).

---

## What it does

An agent connects over Streamable HTTP and finds three tools:

| Tool | Description | Price |
|------|-------------|-------|
| `screen_wallet` | Screen a wallet address against the Chainalysis on-chain sanctions oracle (US/EU/UN lists). | $0.01 |
| `verify_uk_company` | Look up a UK company by registration number: status, type, incorporation, registered address, and people with significant control. | $0.01 |
| `diligence` | Run both checks in parallel, with an explicit disclaimer that no link between wallet and company is established. | $0.015 |

Each result is the same factual data the [HTTP API](https://api.onchaindiligence.com) returns — the check logic is shared byte-for-byte, so an agent calling via MCP gets results identical to one calling over HTTP.

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

## Architecture

```
agent (MCP client + x402 wallet)
      │  Streamable HTTP
      ▼
index.ts ──────────── Hono app, routes /mcp to the handler
      ▼
src/server.ts ─────── createPaidMcpHandler: 3 paidTools, x402 gating
      │
      ├── src/chainalysis.ts ──── sanctions oracle read (viem, Ethereum mainnet)
      └── src/companiesHouse.ts ─ UK Companies House lookup
```

- **`src/server.ts`** — defines the three `paidTool`s with their prices and Zod schemas, wired to the Coinbase facilitator for x402 settlement.
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

To exercise the full paid loop against the running server:

```bash
# in .env, also set PAYER_PRIVATE_KEY to a wallet funded with testnet USDC + ETH
npm run test:client
```

## Design notes

A few decisions worth explaining, since they reflect real constraints rather than preference:

- **Why Base and not Tempo.** The HTTP API settles on Tempo, so unifying on one chain would have been cleaner. But the `x402-mcp` package hardcodes its network type to `"base" | "base-sepolia"` — Tempo is not a permitted value. Rather than fork the package or write a custom facilitator, this server settles on Base, and OnchainDiligence accepts two rails. The constraint is documented, not papered over.

- **The test client is hand-rolled.** `x402-mcp` ships a `withPayment` helper, but it imports an MCP client API (`experimental_MCPClient`) that the `ai` SDK removed in v5. Rather than pin an old `ai` version, `test/client.ts` performs the x402 loop directly on the MCP SDK plus `x402/client` — calling unpaid to get requirements, building a payment header, and retrying with payment in `_meta`. The server itself doesn't depend on `ai`, so this is a test-only concern.

- **Check logic is shared, not reimplemented.** `chainalysis.ts` and `companiesHouse.ts` are copied unchanged from the HTTP API so that a result is the same regardless of which rail an agent uses. Consistency across surfaces matters more than DRY across repos here.

## Not a compliance program

OnchainDiligence returns factual checks and signed attestations. It is **not** legal or compliance advice and is not a substitute for a full compliance program. The sanctions oracle returns a match flag, not rich case detail. Results are never cached.

## License

MIT — see [LICENSE](./LICENSE).
