/**
 * api/index.ts — Vercel entry point.
 *
 * The x402 MCP handler is a web-standard (Request -> Response) function, so the
 * Vercel Node runtime can call it directly. We route all methods to it; the MCP
 * Streamable HTTP transport uses POST for JSON-RPC and may use GET for streaming.
 */
import { handler } from '../src/server.js'

export const config = { runtime: 'nodejs' }

export default async function (request: Request): Promise<Response> {
  return handler(request)
}
