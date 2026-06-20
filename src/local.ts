/**
 * local.ts — run the MCP server locally for testing.
 *
 * Vercel uses api/index.ts; locally we wrap the same web-standard handler in a
 * tiny Node HTTP server via Hono so the test client can reach it at
 * http://localhost:3000/mcp.
 */
import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { handler } from './server.js'

const app = new Hono()

// Route all methods on /mcp to the x402 MCP handler (Streamable HTTP uses POST
// for JSON-RPC, may use GET for streaming).
app.all('/mcp', (c) => handler(c.req.raw))

// Simple liveness check.
app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))

const port = Number(process.env.PORT || 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`MCP server listening on http://localhost:${info.port}`)
  console.log(`  MCP endpoint: http://localhost:${info.port}/mcp`)
})
