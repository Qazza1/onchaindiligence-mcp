/**
 * finalizeClient.ts — D2.2B2: the pure (DOM-free) retry logic for POST
 * /receipts/finalize, split out of main.ts so it is unit-testable without a
 * browser. This module imports nothing wallet- or payment-related — it only
 * ever knows how to re-POST the same transaction hash to the free finalize
 * endpoint. That is an architectural guarantee, not just a runtime check:
 * there is nothing in this file capable of requesting a signature or moving
 * funds.
 *
 * Capability handling (D2.3 Task 7): cleared via `holder.clear()` ONLY on a
 * DEFINITIVE outcome -- 200 success, or one of a narrow ALLOWLIST of
 * terminal failure statuses (400 bad input, 401 expired/invalid capability,
 * 409 conflict with a different transaction) where the server has told us
 * unambiguously that this capability can never succeed. Every other
 * response -- 429 (rate limited), 425/503 (FinalizationPendingError), any
 * other/unexpected status, AND a network-level failure where no response
 * was received at all -- retains the capability. A retry with the exact
 * same transaction hash is always safe regardless of what actually
 * happened server-side, because finalization is idempotent for a given
 * (capability, transaction hash) pair (see db.ts's consumeCapabilityAndPublish
 * "replay" outcome) -- so "we don't know what happened" is never a reason
 * to force the operator to abandon a capability that might still work.
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

/** The ONLY statuses that mean "this capability is definitively, permanently unusable" -- see file header. Everything else retains the capability. */
const DEFINITIVE_TERMINAL_STATUSES = new Set([400, 401, 409])

export async function attemptFinalize(
  transactionHash: string,
  preflightReceiptId: string,
  holder: FinalizeCapabilityHolder,
  deps: FinalizeClientDeps
): Promise<FinalizeAttemptOutcome> {
  const capability = holder.get()
  if (!capability) return { kind: 'failed', message: 'no finalization capability held in memory' }

  let res: Response
  try {
    res = await deps.postFinalize(transactionHash, capability)
  } catch (err: any) {
    // Network/transport failure -- we cannot tell whether the request ever
    // reached the server, so we cannot tell whether it was consumed. Retain
    // the capability; a retry with the SAME transaction hash is always safe.
    return {
      kind: 'pending',
      reason: 'network-error',
      message: err?.message ?? 'a network error occurred contacting the finalize endpoint',
      retryAfterSeconds: 10,
    }
  }

  if (res.status !== 200) {
    const body = await res.clone().json().catch(() => null)
    const message = typeof (body as any)?.error === 'string' ? (body as any).error : `HTTP ${res.status}`

    if (DEFINITIVE_TERMINAL_STATUSES.has(res.status)) {
      // The server has told us unambiguously this capability can never
      // succeed (bad input, expired/invalid, or already consumed for a
      // different transaction). No point retaining it.
      holder.clear()
      return { kind: 'failed', message }
    }

    // Ambiguous or explicitly-retryable: 429 (rate limited), 425/503
    // (FinalizationPendingError), or any other/unexpected status. The
    // server has NOT told us the capability is unusable, so retain it.
    const reason = typeof (body as any)?.reason === 'string' ? (body as any).reason : res.status === 429 ? 'rate-limited' : 'unknown'
    const retryAfterSeconds = Number(res.headers.get('retry-after')) || 10
    return { kind: 'pending', reason, message, retryAfterSeconds }
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
