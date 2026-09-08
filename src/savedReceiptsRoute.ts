import type { Context, Hono } from 'hono'
import { authenticateAccount } from './accounts.js'
import { listSavedReceiptsForAccount, removeSavedReceiptForAccount, saveReceiptForAccount } from './db.js'
import { normalizeReceiptId } from './receipts.js'
import { resolvePublicReceipt } from './receiptsRoute.js'

type Dependencies = { authenticateAccount?: typeof authenticateAccount; listSavedReceiptsForAccount?: typeof listSavedReceiptsForAccount; saveReceiptForAccount?: typeof saveReceiptForAccount; removeSavedReceiptForAccount?: typeof removeSavedReceiptForAccount; resolvePublicReceipt?: typeof resolvePublicReceipt }
async function account(c: Context, deps: Dependencies) { const value = await (deps.authenticateAccount ?? authenticateAccount)(c.req.header('authorization')); if (!value) { c.header('WWW-Authenticate', 'Bearer realm="saved-receipts"'); return null }; return value }
export function mountSavedReceipts(app: Hono, deps: Dependencies = {}) {
  app.get('/me/saved-receipts', async c => { const a = await account(c, deps); if (!a) return c.json({ error: 'missing or invalid account API key' }, 401); return c.json({ saved_receipts: await (deps.listSavedReceiptsForAccount ?? listSavedReceiptsForAccount)(a.accountId) }) })
  app.post('/me/saved-receipts', async c => { const a = await account(c, deps); if (!a) return c.json({ error: 'missing or invalid account API key' }, 401); const body = await c.req.json().catch(() => null) as any; const receiptId = typeof body?.receipt_id === 'string' ? normalizeReceiptId(body.receipt_id) : null; if (!receiptId) return c.json({ error: 'invalid receipt_id' }, 400); const resolved = await (deps.resolvePublicReceipt ?? resolvePublicReceipt)(receiptId); if (!resolved.ok) return c.json({ error: 'public receipt not found' }, 404); return c.json({ saved_receipt: await (deps.saveReceiptForAccount ?? saveReceiptForAccount)(a.accountId, receiptId) }, 201) })
  app.delete('/me/saved-receipts/:receiptId', async c => { const a = await account(c, deps); if (!a) return c.json({ error: 'missing or invalid account API key' }, 401); const receiptId = normalizeReceiptId(c.req.param('receiptId') ?? ''); if (!receiptId) return c.json({ error: 'invalid receipt_id' }, 400); const removed = await (deps.removeSavedReceiptForAccount ?? removeSavedReceiptForAccount)(a.accountId, receiptId); return c.json({ removed }) })
}
