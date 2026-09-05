/**
 * receiptToolsRoute.ts — POST /verify-receipt (D2.5, Section 7).
 *
 * FREE. Not under /x402/* -- no payment middleware, no signing call. Calls
 * the exact same receiptTools.ts primitives the get_receipt/verify_receipt
 * MCP tools call (server.ts) -- see that file's own header for why this
 * exists and what trust model it actually offers.
 *
 * GET /receipts/:receiptId (get_receipt's HTTP equivalent) already exists —
 * see receiptsRoute.ts, unchanged by D2.5.
 */
import type { Hono } from 'hono'
import { verifyReceipt, VerifyReceiptInputError } from './receiptTools.js'

export function mountVerifyReceipt(app: Hono): void {
  app.post('/verify-receipt', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object with receipt_id or envelope' }, 400)
    }
    try {
      const result = await verifyReceipt(body as { receipt_id?: string; envelope?: unknown })
      return c.json(result, 200)
    } catch (err: any) {
      if (err instanceof VerifyReceiptInputError) return c.json({ error: err.message }, 400)
      return c.json({ error: err?.message || 'verification failed' }, 500)
    }
  })
}
