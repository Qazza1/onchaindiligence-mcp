/**
 * finalizeClient.ts — D2.2B2: the pure (DOM-free) retry logic for POST
 * /receipts/finalize, split out of main.ts so it is unit-testable without a
 * browser. This module imports nothing wallet- or payment-related — it only
 * ever knows how to re-POST the same transaction hash to the free finalize
 * endpoint. That is an architectural guarantee, not just a runtime check:
 * there is nothing in this file capable of requesting a signature or moving
 * funds.
 *
 * Capability handling: cleared via `holder.clear()` ONLY on a definitive
 * outcome (200 success, or a terminal non-200/425/503 failure). A 425/503
 * "pending" response leaves the capability untouched, because the server
 * has explicitly not consumed it either (see src/finalizeRoute.ts's
 * FinalizationPendingError).
 */

export interface FinalizeCapabilityHolder {
  get(): string | null
  clear(): void
}

export interface FinalizeClientDeps {
  /** Posts the free finalize request for exactly this transaction hash, using the held capability. Never anything else. */
  postFinalize: (transactionHash: string, capability: string) => Promise<Response>
  verifyReceipt: (envelope: unknown) => Promise<{ state: string; code: string; message: string }>
}

export type FinalizeAttemptOutcome =
  | { kind: 'done'; envelope: any }
  | { kind: 'pending'; reason: string; message: string; retryAfterSeconds: number }
  | { kind: 'failed'; message: string }

export async function attemptFinalize(
  transactionHash: string,
  preflightReceiptId: string,
  holder: FinalizeCapabilityHolder,
  deps: FinalizeClientDeps
): Promise<FinalizeAttemptOutcome> {
  const capability = holder.get()
  if (!capability) return { kind: 'failed', message: 'no finalization capability held in memory' }

  const res = await deps.postFinalize(transactionHash, capability)

  if (res.status === 425 || res.status === 503) {
    // Retryable: the server has explicitly NOT consumed the capability.
    // Keep it in memory -- do not clear it here.
    const body = await res.json().catch(() => null)
    const reason = typeof (body as any)?.reason === 'string' ? (body as any).reason : 'unknown'
    const message = typeof (body as any)?.error === 'string' ? (body as any).error : `HTTP ${res.status}`
    const retryAfterSeconds = Number(res.headers.get('retry-after')) || 10
    return { kind: 'pending', reason, message, retryAfterSeconds }
  }

  if (res.status !== 200) {
    // Terminal failure (expired/invalid capability, conflict, bad input):
    // the capability is no longer usable either way.
    const body = await res.json().catch(() => null)
    const message = typeof (body as any)?.error === 'string' ? (body as any).error : `finalization returned HTTP ${res.status}`
    holder.clear()
    return { kind: 'failed', message }
  }

  // Definitive success.
  const envelope = (await res.json()) as any
  holder.clear()
  const receipt = envelope.receipt

  if (receipt.receipt_type !== 'COMMERCE') return { kind: 'failed', message: 'finalized receipt_type was not COMMERCE' }
  if (receipt.links?.preflight_receipt_id !== preflightReceiptId) return { kind: 'failed', message: 'Commerce Receipt does not reference the preflight receipt' }
  if (receipt.decision?.status !== 'ALLOW') return { kind: 'failed', message: `Commerce Receipt decision was not ALLOW (${receipt.decision?.status})` }
  if (receipt.execution?.status !== 'CONFIRMED') return { kind: 'failed', message: `Commerce Receipt execution was not CONFIRMED (${receipt.execution?.status})` }
  if (receipt.settlement?.status !== 'CONFIRMED') return { kind: 'failed', message: `Commerce Receipt settlement was not CONFIRMED (${receipt.settlement?.status})` }

  const verification = await deps.verifyReceipt(envelope)
  if (verification.state !== 'VALID') {
    return { kind: 'failed', message: `COMMERCE receipt did not independently verify VALID (${verification.state}: ${verification.code})` }
  }

  return { kind: 'done', envelope }
}
