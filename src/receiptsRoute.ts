/**
 * receiptsRoute.ts — GET /receipts/:receiptId, the D2.0A public receipt
 * resolver.
 *
 * Read-only, unauthenticated (receipts are meant to be publicly verifiable),
 * served from the bundled ReceiptStore. Deliberately no POST/publish route
 * here: this task does not add a public arbitrary-write endpoint — dynamic
 * publication is D2.1/D2.2 (see docs/PUBLIC_ACTION_RECEIPT_V1.md §10).
 *
 * CORS is scoped to the exact production OnchainDiligence website origin(s)
 * the Receipt Explorer runs on — never a wildcard — matching the existing
 * WEB_ALLOWED_ORIGINS convention in the HTTP API repo (onchaindilige/src/server.ts).
 */
import type { Hono } from 'hono'
import { cors } from 'hono/cors'
import { normalizeReceiptId } from './receipts.js'
import { receiptStore, type ReceiptStore } from './receiptStore.js'

const RECEIPT_ALLOWED_ORIGINS = ['https://onchaindiligence.com']

export function mountReceipts(app: Hono, store: ReceiptStore = receiptStore): void {
  app.use(
    '/receipts/*',
    cors({ origin: RECEIPT_ALLOWED_ORIGINS, allowMethods: ['GET', 'OPTIONS'], maxAge: 86400 })
  )

  app.get('/receipts/:receiptId', async (c) => {
    const requested = c.req.param('receiptId')
    const normalized = normalizeReceiptId(requested)
    if (!normalized) {
      return c.json({ error: 'malformed receipt id' }, 400)
    }
    const envelope = await store.get(normalized)
    if (!envelope) {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json(envelope, 200)
  })
}
