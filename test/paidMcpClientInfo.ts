/** Focused test for CHECK 2 (paid MCP clientInfo capture).
 *
 * Proves, through the REAL paid `/mcp` route -- the exact same handler
 * wiring index.ts uses (src/server.ts's exported `handler`, and telemetry.ts's
 * real `readMcpEnvelope`/`recordEvent`, nothing reimplemented or mocked) --
 * mounted on a Hono app exactly as index.ts mounts it, that:
 *
 *   initialize -> clientInfo is read from the request body ->
 *   mcp.session is emitted with surface="paid", client_name, client_version,
 *   transport="streamable-http"
 *
 * index.ts's full app is not imported here only because it also mounts many
 * unrelated routes (allowance/swap/bridge/staking/webhooks/workspace/etc.)
 * that would need their own unrelated fixtures to import cleanly -- the
 * three lines under test below are copied verbatim from index.ts's own
 * `/mcp` handler, not reimplemented differently.
 *
 * No payment is made and no paid tool is called: `initialize` is handled
 * entirely by the MCP transport/session layer, before any paidTool's
 * payment gate ever runs -- so this never touches the CDP facilitator.
 *
 * Run with: npx tsx test/paidMcpClientInfo.ts
 */

import assert from 'node:assert/strict'
import { Hono } from 'hono'

process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'
delete process.env.DATABASE_URL

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

// Same benign, expected-and-swallowed failure test/x402Routes.ts already
// documents: constructing the CDP facilitator config with placeholder
// credentials fails asynchronously on first real use. `initialize` never
// reaches that code path, so this guard is defensive precedent, not
// something this test expects to actually fire.
process.on('unhandledRejection', (error: unknown) => {
  const message = String((error as Error)?.message ?? error)
  if (message.includes('no supported payment kinds loaded from any facilitator')) return
  throw error
})

// The real production paid-MCP handler and the real telemetry helpers --
// nothing about either is mocked or reimplemented for this test.
const { handler } = await import('../src/server.js')
const { readMcpEnvelope, recordEvent } = await import('../src/telemetry.js')

// Verbatim copy of index.ts's own `/mcp` route body (see index.ts, the
// `app.all('/mcp', ...)` handler), so this test exercises the identical
// logic production runs, without also mounting index.ts's many unrelated
// routes.
const app = new Hono()
app.all('/mcp', async (c) => {
  try {
    const envelope = readMcpEnvelope(await c.req.raw.clone().text())
    recordEvent('mcp.request', { surface: 'paid', method: envelope.method, tool: envelope.tool })
    if (envelope.clientName || envelope.clientVersion) {
      recordEvent('mcp.session', {
        surface: 'paid',
        client_name: envelope.clientName,
        client_version: envelope.clientVersion,
        transport: 'streamable-http',
      })
    }
  } catch {
    // Best-effort only.
  }
  return handler(c.req.raw)
})

const logged: string[] = []
const realLog = console.log
console.log = (line?: any) => {
  logged.push(String(line))
}

let response: Response
try {
  response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'paid-mcp-durability-check', version: '9.9.9' },
      },
    }),
  })
} finally {
  console.log = realLog
}

assert.equal(response.status, 200, 'a bare initialize request must never be payment-gated')
// The default paid-surface transport responds as text/event-stream (SSE),
// unlike the public surface's enableJsonResponse:true -- extract the JSON
// payload from the SSE "data:" line rather than assuming a bare JSON body.
const rawBody = await response.text()
const dataLine = rawBody.split('\n').find((line) => line.startsWith('data:'))
assert.ok(dataLine, `expected an SSE data line in the initialize response, got: ${rawBody}`)
const body = JSON.parse(dataLine!.slice('data:'.length).trim())
assert.ok(body.result?.protocolVersion, 'initialize must succeed and negotiate a protocol version')
console.log('ok  a bare initialize POST through the real paid /mcp route succeeds with no payment gate')

const requestLines = logged.filter((line) => line.includes('"event":"mcp.request"'))
assert.equal(requestLines.length, 1, `expected exactly one mcp.request event, got: ${JSON.stringify(logged)}`)
assert.deepEqual(JSON.parse(requestLines[0].slice('x402_funnel '.length)), {
  event: 'mcp.request',
  surface: 'paid',
  method: 'initialize',
})
console.log('ok  mcp.request{surface:"paid", method:"initialize"} fires alongside mcp.session, unchanged shape')

const sessionLines = logged.filter((line) => line.includes('"event":"mcp.session"'))
assert.equal(sessionLines.length, 1, `expected exactly one mcp.session event, got: ${JSON.stringify(logged)}`)
const parsed = JSON.parse(sessionLines[0].slice('x402_funnel '.length))
assert.deepEqual(parsed, {
  event: 'mcp.session',
  surface: 'paid',
  client_name: 'paid-mcp-durability-check',
  client_version: '9.9.9',
  transport: 'streamable-http',
})
console.log('ok  initialize -> clientInfo read from the request body -> mcp.session{surface:"paid", client_name, client_version, transport} -- real handler, not mocked')

console.log('\nAll paid MCP clientInfo tests passed.')
// src/server.ts's imported mcp-handler starts an un-cleared 30s cleanup
// interval at module load (harmless in a real long-running server; here it
// would otherwise keep this one-off script's process alive forever). Same
// precedent as test/mcpToolDescriptions.ts, which imports the same handler.
process.exit(0)
