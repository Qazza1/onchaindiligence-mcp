/**
 * receiptsRoute.ts — GET /receipts/:receiptId, the public receipt resolver.
 *
 * Read-only, unauthenticated (receipts are meant to be publicly verifiable).
 * Resolution order (D2.2): the durable Postgres store first, falling back
 * to the D2.0A bundled reference store. No enumeration endpoint exists
 * anywhere, and never will via this file — the only supported read is exact
 * lookup by receipt_id.
 *
 * Deliberately no POST/publish route here: this task does not add a public
 * arbitrary-write endpoint — the only write path into durable storage is the
 * capability-bound POST /receipts/finalize (see finalizeRoute.ts) and the
 * paid preflight's own opt-in publication of its own receipt.
 *
 * A private stored receipt and an unknown receipt_id are — and must remain —
 * externally indistinguishable: both return a plain 404. Never leak that a
 * private receipt exists.
 *
 * CORS is scoped to the exact production OnchainDiligence website origin(s)
 * the Receipt Explorer runs on — never a wildcard — matching the existing
 * WEB_ALLOWED_ORIGINS convention in the HTTP API repo (onchaindilige/src/server.ts).
 * Scoped to this route specifically (not a `/receipts/*` wildcard) so it
 * never accidentally applies to the unrelated POST /receipts/finalize route.
 */
import type { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { normalizeReceiptId, checkReceiptStructuralIntegrity, type PublicActionReceiptEnvelope } from './receipts.js'
import { receiptStore, type ReceiptStore } from './receiptStore.js'
import { getPublicReceipt } from './db.js'

const RECEIPT_ALLOWED_ORIGINS = ['https://onchaindiligence.com']

/**
 * D2.3 (Task 4): a database row is not automatically trustworthy merely
 * because it exists. Before returning ANY stored envelope, structurally
 * self-check it (schema shape, receipt_digest, receipt_id — see
 * checkReceiptStructuralIntegrity in receipts.ts) without ever mutating the
 * stored value.
 *
 * This check is 100% local: no key registry fetch, no network call, no
 * signature verification. That's deliberate — a temporary key-registry/RPC
 * outage must never turn an immutable, structurally sound stored receipt
 * into a 404 or an error. It only rejects a row that is provably corrupt or
 * malformed on its face (a bug or storage-layer fault, not an unreachable
 * trust source), which the resolver has never been able to distinguish
 * from a trustworthy row before this check existed.
 */
function respondWithIntegrityCheck(c: Context, envelope: PublicActionReceiptEnvelope) {
  const integrity = checkReceiptStructuralIntegrity(envelope)
  if (!integrity.ok) {
    console.error(`receipt resolver: stored envelope failed structural integrity (${integrity.code}): ${integrity.message}`)
    return c.json({ error: 'stored receipt failed structural integrity check' }, 500)
  }
  return c.json(envelope, 200)
}

export function mountReceipts(
  app: Hono,
  bundledStore: ReceiptStore = receiptStore,
  getDurablePublicReceipt: (receiptId: string) => Promise<PublicActionReceiptEnvelope | null> = getPublicReceipt
): void {
  app.use(
    '/receipts/:receiptId',
    cors({ origin: RECEIPT_ALLOWED_ORIGINS, allowMethods: ['GET', 'OPTIONS'], maxAge: 86400 })
  )

  app.get('/receipts/:receiptId', async (c) => {
    const requested = c.req.param('receiptId')
    const normalized = normalizeReceiptId(requested)
    if (!normalized) {
      return c.json({ error: 'malformed receipt id' }, 400)
    }

    let durable: PublicActionReceiptEnvelope | null = null
    try {
      durable = await getDurablePublicReceipt(normalized)
    } catch {
      // Durable store unreachable: fall through to the bundled store rather
      // than fail the request outright — the D2.0A reference receipt must
      // keep resolving even if Postgres is temporarily unavailable. A real
      // durable-only receipt during an actual outage will read as 404
      // rather than 503; that trade favours never distinguishing "private"
      // from "unknown" over perfect outage signalling.
    }
    if (durable) return respondWithIntegrityCheck(c, durable)

    const bundled = await bundledStore.get(normalized)
    if (!bundled) {
      return c.json({ error: 'not found' }, 404)
    }
    return respondWithIntegrityCheck(c, bundled)
  })
}
