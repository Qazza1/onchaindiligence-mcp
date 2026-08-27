/**
 * index.ts — Vercel entrypoint (and the app definition).
 *
 * Vercel's Node runtime detects a default-exported Hono app as a server
 * entrypoint and turns it into a Function automatically. The same app is used
 * locally by src/local.ts (which imports `app` and calls serve()).
 *
 * Routes:
 *   GET  /                     liveness
 *   ALL  /mcp                  the x402-paid MCP handler (Streamable HTTP)
 *   GET  /x402/screen/:address  additive @x402 + Bazaar discovery route
 */
import { Hono } from 'hono'
import { handler } from './src/server.js'
import { mountDiscovery } from './src/discovery.js'
import { attestationReady, canonicalVerdictReady } from './src/attest.js'

const app = new Hono()
app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))

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

// Registered before either payment implementation so a signing outage fails
// before x402 verification/settlement can collect funds.
app.use('/mcp', requireSigningReadiness)
app.use('/x402/*', requireSigningReadiness)
app.use('/x402/verdict/:address', requireCanonicalVerdictReadiness)
app.all('/mcp', (c) => handler(c.req.raw))

// Additive: mounts GET /x402/screen/:address (paid + Bazaar-discoverable).
// Does not touch the /mcp handler above. Safe to remove by deleting this call
// and src/discovery.ts.
mountDiscovery(app)

export default app
