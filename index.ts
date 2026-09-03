/**
 * index.ts — Vercel entrypoint (and the app definition).
 *
 * Vercel's Node runtime detects a default-exported Hono app as a server
 * entrypoint and turns it into a Function automatically. The same app is used
 * locally by src/local.ts (which imports `app` and calls serve()).
 *
 * Routes:
 *   GET  /                              liveness
 *   GET  /openapi.json                  free: OpenAPI 3.1 for the x402 HTTP API
 *   GET  /.well-known/x402              free: x402 capability manifest
 *   ALL  /mcp                           the x402-paid MCP handler (Streamable HTTP)
 *   GET  /x402/screen/:address          paid: wallet sanctions screen
 *   GET  /x402/screen-name              paid: OFAC name screen
 *   GET  /x402/uk-company/:companyNumber paid: UK Companies House KYB
 *   GET  /x402/us-company               paid: SEC EDGAR company verification
 *   GET  /x402/diligence                paid: combined wallet + UK company
 *   GET  /x402/verdict/:address         paid: PASS / WARN / BLOCK verdict
 */
import { Hono } from 'hono'
import { handler } from './src/server.js'
import { mountDiscovery } from './src/discovery.js'
import { mountPublicMetadata } from './src/publicMetadata.js'
import { mountReceipts } from './src/receiptsRoute.js'
import { attestationReady, canonicalVerdictReady } from './src/attest.js'
import { outcomeForStatus, readMcpEnvelope, recordEvent } from './src/telemetry.js'

const app = new Hono()
app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))

// Free, unauthenticated discovery documents: GET /openapi.json and
// GET /.well-known/x402. Mounted before the paid middleware; neither path
// matches /x402/* so neither is ever payment-gated.
mountPublicMetadata(app)

const requireSigningReadiness = async (c: any, next: () => Promise<void>) => {
  if (!(await attestationReady())) {
    c.header('Retry-After', '10')
    return c.json(
      {
        error: 'attestation service temporarily unavailable',
        detail: 'No payment was requested. Retry when signing readiness is restored.',
      },
      503
    )
  }
  await next()
}

const requireCanonicalVerdictReadiness = async (c: any, next: () => Promise<void>) => {
  if (!(await canonicalVerdictReady())) {
    c.header('Retry-After', '10')
    return c.json(
      {
        error: 'canonical verdict service temporarily unavailable',
        detail: 'No payment was requested. Retry when verdict readiness is restored.',
      },
      503
    )
  }
  await next()
}

/**
 * Aggregate funnel counter for the HTTP x402 rail. Records the matched ROUTE
 * TEMPLATE only — never c.req.path, which embeds caller input such as the
 * screened address or company number. No query string, headers or body is
 * read here. See src/telemetry.ts for the full field allowlist.
 */
const recordHttpFunnel = async (c: any, next: () => Promise<void>) => {
  await next()
  const status = c.res?.status ?? 0
  recordEvent('http.request', {
    route: c.req.routePath ?? 'unknown',
    status,
    outcome: outcomeForStatus(status),
  })
}

// Registered before either payment implementation so a signing outage fails
// before x402 verification/settlement can collect funds.
app.use('/x402/*', recordHttpFunnel)
app.use('/mcp', requireSigningReadiness)
app.use('/x402/*', requireSigningReadiness)
app.use('/x402/verdict/:address', requireCanonicalVerdictReadiness)

/**
 * MCP transport. The funnel needs to distinguish connection attempts from
 * browsing (`tools/list`) from paid intent (`tools/call`), which requires the
 * JSON-RPC method name. Only the method and the static tool name are read —
 * arguments are never touched — from a CLONE, so the original body stream
 * still reaches the handler untouched. Any failure here is swallowed: the
 * paid path must never break because telemetry could not parse something.
 */
app.all('/mcp', async (c) => {
  try {
    const envelope = readMcpEnvelope(await c.req.raw.clone().text())
    recordEvent('mcp.request', envelope)
  } catch {
    // Best-effort only.
  }
  return handler(c.req.raw)
})

// Additive: mounts GET /x402/screen/:address (paid + Bazaar-discoverable).
// Does not touch the /mcp handler above. Safe to remove by deleting this call
// and src/discovery.ts.
mountDiscovery(app)

// D2.0A: mounts GET /receipts/:receiptId, the public Agent Evidence receipt
// resolver. Free, unauthenticated, read-only. Safe to remove by deleting
// this call and src/receiptsRoute.ts.
mountReceipts(app)

export default app
