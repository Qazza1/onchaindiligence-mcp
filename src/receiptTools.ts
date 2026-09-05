/**
 * receiptTools.ts — get_receipt / verify_receipt service primitives (D2.5,
 * Section 7, deferred from D2.3).
 *
 * Both the MCP tools (server.ts) and the free HTTP route
 * (verifyReceiptRoute.ts) call these same two functions — no lifecycle
 * logic is duplicated in either transport. Both reuse the EXACT converged
 * verification contract established in D2.3 (verifyReceiptEnvelope,
 * fetchAttestationKeyRegistry from receipts.ts) and the resolver's own
 * structural-integrity-checked resolution (resolvePublicReceipt from
 * receiptsRoute.ts) — this file adds no new verification semantics of its
 * own.
 *
 * Convenience, not a stronger trust model: verifying a receipt through this
 * ONLINE tool means trusting this server to have fetched the real key
 * registry and run the real check honestly. Running the SAME check
 * yourself, offline, against packages/agent-evidence and your own copy of
 * the key registry is a strictly stronger trust position — this module
 * exists to make the common case convenient, not to replace that option.
 */
import {
  verifyReceiptEnvelope,
  fetchAttestationKeyRegistry,
  checkReceiptStructuralIntegrity,
  type PublicActionReceiptEnvelope,
  type ReceiptVerificationState,
} from './receipts.js'
import { resolvePublicReceipt, type ResolveReceiptResult } from './receiptsRoute.js'
import type { ReceiptStore } from './receiptStore.js'

export type GetReceiptResult =
  | { found: true; envelope: PublicActionReceiptEnvelope }
  | { found: false; reason: 'malformed-id' | 'not-found' | 'unavailable' }

export interface ReceiptToolsDependencies {
  bundledStore?: ReceiptStore
  getDurablePublicReceipt?: (receiptId: string) => Promise<PublicActionReceiptEnvelope | null>
  resolvePublicReceipt?: (receiptId: string, deps?: ReceiptToolsDependencies) => Promise<ResolveReceiptResult>
}

/** Exact receipt ID lookup. Free, structured, no payment -- see file header. */
export async function getReceiptById(receiptId: string, deps: ReceiptToolsDependencies = {}): Promise<GetReceiptResult> {
  const result = await (deps.resolvePublicReceipt ?? resolvePublicReceipt)(receiptId, deps)
  if (result.ok) return { found: true, envelope: result.envelope }
  if (result.reason === 'malformed-id') return { found: false, reason: 'malformed-id' }
  if (result.reason === 'corrupt') return { found: false, reason: 'unavailable' }
  return { found: false, reason: 'not-found' }
}

export interface VerifyReceiptInput {
  /** Look up a public receipt by exact ID and verify it. Mutually exclusive with `envelope`. */
  receipt_id?: string
  /** Verify a caller-supplied envelope directly -- does not need to be publicly resolvable (useful for a receipt the caller holds privately). Mutually exclusive with `receipt_id`. */
  envelope?: unknown
}

export interface VerifyReceiptResult {
  state: ReceiptVerificationState
  code: string
  message: string
  /** Present only when verifying by receipt_id and the id could not even be resolved -- distinguishes "we could not find anything to check" from a genuine verification outcome. */
  resolution_error?: 'malformed-id' | 'not-found' | 'unavailable'
}

export class VerifyReceiptInputError extends Error {}

/**
 * Structured VALID / INVALID / UNVERIFIABLE with reasons/codes -- the same
 * normative contract established in D2.3's verifyReceiptEnvelope, never a
 * bespoke re-derivation. Never throws on a malformed/unresolvable input;
 * callers get a typed result explaining exactly what could not be checked
 * and why.
 */
export async function verifyReceipt(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
  if (input.receipt_id && input.envelope) {
    throw new VerifyReceiptInputError('supply exactly one of receipt_id or envelope, not both')
  }
  if (!input.receipt_id && !input.envelope) {
    throw new VerifyReceiptInputError('supply one of receipt_id or envelope')
  }

  let envelope: PublicActionReceiptEnvelope
  if (input.receipt_id) {
    const resolved = await resolvePublicReceipt(input.receipt_id)
    if (!resolved.ok) {
      const resolution_error = resolved.reason === 'malformed-id' ? 'malformed-id' : resolved.reason === 'corrupt' ? 'unavailable' : 'not-found'
      return {
        state: 'UNVERIFIABLE',
        code: `resolution-${resolution_error}`,
        message:
          resolution_error === 'malformed-id'
            ? 'the supplied receipt_id is not a validly formatted OCD receipt id'
            : resolution_error === 'not-found'
              ? 'no public receipt exists for this id (it may be private, or the id may be wrong)'
              : 'the stored receipt failed a local structural integrity check',
        resolution_error,
      }
    }
    envelope = resolved.envelope
  } else {
    // A caller-supplied envelope skips the resolver (it need not be public
    // or stored) but MUST still pass the exact same structural-integrity
    // check before proof/signature verification even runs -- schema shape,
    // digest, and id self-consistency are prerequisites, not optional.
    const integrity = checkReceiptStructuralIntegrity(input.envelope)
    if (!integrity.ok) {
      return { state: 'INVALID', code: integrity.code, message: integrity.message }
    }
    envelope = input.envelope as PublicActionReceiptEnvelope
  }

  const registry = await fetchAttestationKeyRegistry()
  const verification = verifyReceiptEnvelope(envelope, registry)
  return { state: verification.state, code: verification.code, message: verification.message }
}
