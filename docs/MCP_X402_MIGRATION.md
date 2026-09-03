# Migration note: MCP payment transport v1 → v2 (D1.2)

**Status: not started. Deliberately deferred out of D1.1.** D1.1 activated and
measured the standard HTTP x402 rail without touching the MCP payment
transport, so the live `/mcp` server behaves exactly as it did before.

## Where we are

`POST /mcp` is served by `x402-mcp@0.1.1`, which depends on `x402@0.5.3` — the
**v1** protocol package. The HTTP `/x402/*` rail added alongside it uses the
**v2** stack (`@x402/core`, `@x402/hono`, `@x402/evm`, `@x402/extensions`).
One repository, two x402 versions, on purpose.

| | current `/mcp` (v1) | official v2 MCP |
|---|---|---|
| Package | `x402-mcp@0.1.1` | `@x402/mcp` |
| `x402Version` | `1` | `2` |
| Network identifier | `"base"` | `"eip155:8453"` (CAIP-2) |
| Amount field | `maxAmountRequired` | `amount` |
| Resource identifier | `mcp://tool/<name>` | per v2 conventions |
| Unpaid tool call | HTTP 200 + `isError` result carrying `accepts` | per v2 conventions |
| Payment channel | `_meta["x402/payment"]` | per v2 conventions |

The ecosystem has moved: of 15,357 resources in the public CDP Bazaar index,
15,349 are v2 and 8 are v1. The v1 MCP rail is the outlier.

## Why not now

Nothing about the v1 rail is broken for its existing users, and migrating it is
a change to a **live, revenue-bearing payment path** whose clients we do not
control. The cheaper activation win (HTTP + Bazaar discovery) does not require
it. Sequence the risk: activate and measure the HTTP rail first, then migrate
MCP with real funnel data to compare against.

## What must be regression-tested before migrating

1. **MCP Registry behaviour** — the server is listed; confirm the registry
   entry, transport declaration and health checks still resolve after the swap.
2. **External MCP clients** — anything already paying the v1 rail (including
   any client using `x402-mcp`'s own client half) will break if the payment
   channel or challenge shape changes. Identify callers from the funnel
   counters (`mcp.request` events) before, not after.
3. **`tools/list`** — tool names, descriptions and JSON schemas must be
   byte-stable, or agents that cached the tool list will mis-call.
4. **Tool input schemas** — the zod schemas define the paid contract; any
   change is a breaking API change independent of payment.
5. **Payment challenge shape** — v1 returns `isError` + `structuredContent`
   with `accepts`. Confirm exactly what v2 returns and whether HTTP status,
   `_meta` key, and error shape change.
6. **Signed result behaviour** — every paid result must still be wrapped in the
   `{ data, attestation }` envelope, and signing readiness must still be
   checked *before* payment can be collected (`requireSigningReadiness`).
7. **Price parity** — both rails read `config.prices`; confirm the v2 MCP path
   still quotes the same amounts in the same asset on the same network.
8. **Facilitator wiring** — the current code casts the `@coinbase/x402`
   facilitator config across a v1/v2 type boundary in `server.ts`. That cast
   should disappear on migration; verify verify/settle still work without it.
9. **Non-custodial guarantee** — re-confirm no path can execute a paid tool
   body before the facilitator verifies payment.

## Suggested approach

Migrate behind a flag on a preview deployment, run both rails side by side
against the same checks, and compare `tools/list` output and challenge shapes
byte for byte before switching production. Do not migrate and re-price in the
same change.
