# OnchainDiligence MCP — build notes

## What this is
A standalone x402-paid MCP server exposing the same three compliance checks as the
HTTP API (`api.onchaindiligence.com`), but as MCP tools agents can call and pay for
over Streamable HTTP. Separate project from the HTTP API by design (separate payment
rail, separate blast radius). Intended home: `mcp.onchaindiligence.com`.

## Payment rail (IMPORTANT finding)
- The HTTP API settles in MPP / pathUSD / Tempo.
- THIS MCP server settles in **x402 / USDC / Base** — because the `x402-mcp` package
  hardcodes `network: "base-sepolia" | "base"` in its TS types. Tempo is NOT an
  option in the package. So "x402 on Tempo" (option 2b) is not buildable with this
  package today; it would need a forked package or custom facilitator. We are
  building option 2a (USDC on Base), which is the de-risked, working path.
- This means OnchainDiligence accepts TWO payment rails: MPP/Tempo (HTTP) and
  x402/Base (MCP). That is intentional and worth documenting for users.

## Verified package API (read from installed .d.ts, not guessed)
- `x402-mcp@0.1.1`:
    createPaidMcpHandler(init, serverOptions, config) => (req: Request) => Promise<Response>
    config: { ...mcpHandlerConfig, recipient: Address, facilitator: FacilitatorConfig,
              network: "base" | "base-sepolia" }
    server.paidTool(name, description, { price }, paramsZodShape, annotations, cb)
- `@coinbase/x402@2.1.0`:
    createFacilitatorConfig(apiKeyId, apiKeySecret) => FacilitatorConfig
    (feeds the facilitator field above using CDP keys)
- Handler is web-standard (Request->Response), mounts in Hono or as a Vercel fn.
  No Next.js required.

## Build order (de-risked)
1. [in progress] MCP server with 3 tools wired to reused check logic, NO payment yet,
   confirm it responds locally.
2. Layer x402 paidTool + Coinbase facilitator on top.
3. Deploy to Vercel as its own project, domain mcp.onchaindiligence.com.
4. Register in MCP registry / x402 discovery indexes.
5. Document on the /docs page.

## Reused modules (copied from the HTTP API, logic unchanged)
- chainalysis.ts  — sanctions oracle read (viem, Ethereum mainnet, isSanctioned())
- companiesHouse.ts — UK Companies House lookup (profile + PSC)
Both kept byte-for-byte in behavior so MCP results == HTTP results.

## Env vars needed
- COMPANIES_HOUSE_API_KEY   (same as HTTP API)
- SANCTIONS_ORACLE_RPC_URL  (Ethereum RPC, e.g. ethereum-rpc.publicnode.com)
- X402_RECIPIENT_ADDRESS    (a BASE address to receive USDC — NOT the Tempo one)
- CDP_API_KEY_ID            (Coinbase Developer Platform)
- CDP_API_KEY_SECRET        (Coinbase Developer Platform)
- X402_NETWORK              ("base-sepolia" for testing, "base" for mainnet)

## PROGRESS (verified in sandbox)
- Server boots, serves Streamable HTTP at /mcp.
- tools/list returns all 3 tools with paymentHint:true. ✓
- Calling a paid tool with no payment returns correct x402 requirements:
  amount 10000 atomic ($0.01 USDC), payTo = recipient, asset = base-sepolia USDC,
  network base-sepolia, scheme exact. ✓
- Full PAID round-trip must be tested on the user's machine (needs real CDP keys
  for the facilitator + funded payer wallet + network access). Test client is
  test/client.ts (low-level: MCP SDK + x402/client createPaymentHeader, bypasses
  ai v5 incompatibility in x402-mcp's withPayment helper).

## ai v5 GOTCHA (important)
x402-mcp@0.1.1's withPayment() imports `experimental_MCPClient` from `ai`, which
ai v5 REMOVED. So withPayment is unusable with ai v5. Our server does NOT use ai
at all (unaffected). For the client/test we hand-roll payment with x402/client.
Real agents bring their own x402-capable client, so this is a test-only concern.

## x402-over-MCP protocol (learned from reading x402-mcp source)
- Payment rides in tools/call params._meta["x402/payment"] (NOT an HTTP header).
- Unpaid call -> { isError:true, structuredContent:{ x402Version, error,
  accepts:[paymentRequirements] } }.
- createPaymentHeader(account, 1, requirements) builds the header from x402/client.
- Server verifies+settles via the Coinbase facilitator (useFacilitator).

## Local test files added
- src/local.ts   — Hono+node-server wrapper to run /mcp on localhost.
- test/client.ts — low-level paying client (the real end-to-end test).
- scripts: npm run dev (server), npm run test:client (payer).
