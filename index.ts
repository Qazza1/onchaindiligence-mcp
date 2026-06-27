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

const app = new Hono()
app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))
app.all('/mcp', (c) => handler(c.req.raw))

// Additive: mounts GET /x402/screen/:address (paid + Bazaar-discoverable).
// Does not touch the /mcp handler above. Safe to remove by deleting this call
// and src/discovery.ts.
mountDiscovery(app)

export default app
