/**
 * index.ts — Vercel entrypoint (and the app definition).
 *
 * Vercel's Node runtime detects a default-exported Hono app as a server
 * entrypoint and turns it into a Function automatically. The same app is used
 * locally by src/local.ts (which imports `app` and calls serve()).
 *
 * Routes:
 *   GET  /        liveness
 *   ALL  /mcp     the x402-paid MCP handler (Streamable HTTP)
 */
import { Hono } from 'hono'
import { handler } from './src/server.js'

const app = new Hono()

app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))
app.all('/mcp', (c) => handler(c.req.raw))

export default app
