/**
 * local.ts — run the MCP server locally for testing.
 *
 * Imports the SAME Hono app that Vercel uses (../index.ts) and wraps it in a
 * Node HTTP server so the test client can reach it at http://localhost:3000/mcp.
 * This keeps local and production identical — one app definition.
 */
import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from '../index.js'

const port = Number(process.env.PORT || 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`MCP server listening on http://localhost:${info.port}`)
  console.log(`  MCP endpoint: http://localhost:${info.port}/mcp`)
})
