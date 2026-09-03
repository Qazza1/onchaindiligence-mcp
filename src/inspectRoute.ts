/**
 * inspectRoute.ts — POST /inspect/payment (D2.1A).
 *
 * FREE. Deliberately NOT under /x402/* — that namespace means "paid
 * resource," and this one is not. No payment middleware, no signing call,
 * no receipt. Pure deterministic policy inspection so an agent can sanity
 * check a proposed payment before deciding whether the $0.01
 * POST /x402/preflight-payment (signed receipt + optional sanctions
 * evidence) is worth paying for — see docs/PAYMENT_PREFLIGHT.md.
 *
 * Exists to avoid a bootstrapping loop: an agent should not need to make an
 * x402 payment merely to perform the most basic deterministic inspection of
 * another proposed x402 payment.
 */
import type { Hono } from 'hono'
import { inspectPayment, PreflightInputError } from './preflight.js'

// Single source of truth, reused by the MCP tool description (src/server.ts)
// and the OpenAPI document (src/publicMetadata.ts) so the two surfaces can
// never silently drift apart on what this endpoint actually does.
export const INSPECT_DESCRIPTION =
  'FREE. Pure deterministic inspection of a proposed payment against structured policy ' +
  '(amount/network/asset/recipient/resource) — no external evidence, no sanctions ' +
  'screening, no cryptographic signing, no receipt. Returns the same ALLOW / ' +
  'REQUIRE_APPROVAL / BLOCK decision semantics as POST /x402/preflight-payment for the ' +
  'deterministic checks alone, so a caller can sanity-check a proposal before deciding ' +
  'whether the paid preflight (adds optional sanctions evidence and a signed, ' +
  'independently-verifiable receipt, $0.01) is worth paying for. This result is NOT ' +
  'cryptographically attested and carries no receipt — receipt is always null.'

export function mountInspect(app: Hono): void {
  app.post('/inspect/payment', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    try {
      const result = await inspectPayment(body)
      return c.json(result, 200)
    } catch (err: any) {
      if (err instanceof PreflightInputError) return c.json({ error: err.message }, 400)
      return c.json({ error: err?.message || 'inspection failed' }, 500)
    }
  })
}
