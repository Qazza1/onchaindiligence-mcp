/**
 * receiptStore.ts — storage abstraction for the receipt resolver.
 *
 * D2.0 scope: a small, immutable, BUNDLED registry — receipts baked into the
 * deployed source at build time (see ./receipts/referenceReceipts.ts). This
 * is deliberately NOT dynamic production persistence: there is no database
 * here, and the existing deployment has no datastore this service can safely
 * reuse for arbitrary write-at-runtime receipt publication (see
 * docs/PUBLIC_ACTION_RECEIPT_V1.md §10 and the D2.0A task notes).
 * `BundledReceiptStore` exists so a later D2.1/D2.2 can swap in durable,
 * append-only storage behind the same `ReceiptStore` interface without
 * changing the resolver route.
 */
import { computeReceiptDigest, formatReceiptId, type PublicActionReceiptEnvelope } from './receipts.js'
import { REFERENCE_RECEIPTS } from './receipts/referenceReceipts.js'

export interface ReceiptStore {
  get(receiptId: string): Promise<PublicActionReceiptEnvelope | null>
}

/** Immutable, bundled-at-deploy-time receipt registry. Not dynamic storage. */
export class BundledReceiptStore implements ReceiptStore {
  private readonly byId: ReadonlyMap<string, PublicActionReceiptEnvelope>

  constructor(envelopes: PublicActionReceiptEnvelope[]) {
    this.byId = new Map(envelopes.map((envelope) => [envelope.receipt.receipt_id, envelope]))
  }

  async get(receiptId: string): Promise<PublicActionReceiptEnvelope | null> {
    const envelope = this.byId.get(receiptId)
    if (!envelope) return null
    const { receipt_id, receipt_digest, ...core } = envelope.receipt
    if (
      receipt_id !== receiptId ||
      computeReceiptDigest(core) !== receipt_digest ||
      formatReceiptId(receipt_digest) !== receiptId
    ) {
      return null
    }
    return envelope
  }
}

export const receiptStore: ReceiptStore = new BundledReceiptStore(REFERENCE_RECEIPTS)
