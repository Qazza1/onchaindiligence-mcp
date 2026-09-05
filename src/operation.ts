/**
 * operation.ts — durable operation identity (D2.4, Section 2).
 *
 * ONE operation represents ONE intended merchant payment, from proposal
 * through execution and observation. `operation_id` is random and opaque —
 * it must never be derived from or leak invoice/customer/private semantic
 * data, and knowing it alone grants no access. A separate, higher-entropy
 * `recovery_credential` is required to read or resume anything about the
 * operation; only its SHA-256 hash is ever persisted (same discipline as
 * capability.ts's finalization capabilities — see that file's header).
 *
 * The recovery credential authorizes lifecycle recovery ONLY. It does NOT:
 *   - authorize wallet spending
 *   - establish payer identity
 *   - establish evidentiary truth
 * It is exactly as trustworthy as "the holder is the same party that
 * created this operation" — nothing more.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createCommerceOperation, getCommerceOperation, type CommerceOperationRecord } from './db.js'

const OPERATION_ID_PREFIX = 'OCD-OP-'

/**
 * Random and opaque by construction: 20 bytes of crypto randomness,
 * base64url-encoded. Deliberately NOT content-derived (unlike receipt ids),
 * since an operation is not a piece of content to be digested — it is a
 * durable slot that content gets written into over time.
 */
function generateOperationId(): string {
  return OPERATION_ID_PREFIX + randomBytes(20).toString('base64url')
}

function generateRecoveryCredential(): string {
  return randomBytes(32).toString('base64url') // 256 bits, same as finalization capabilities
}

export function hashRecoveryCredential(rawCredential: string): string {
  return createHash('sha256').update(rawCredential, 'utf8').digest('hex')
}

export function isValidOperationIdFormat(value: string): boolean {
  return value.startsWith(OPERATION_ID_PREFIX) && /^[A-Za-z0-9_-]{20,64}$/.test(value.slice(OPERATION_ID_PREFIX.length))
}

export interface CreatedOperation {
  operationId: string
  /** Returned to the caller exactly once. Never stored, never logged. */
  recoveryCredential: string
}

/** Creates a fresh, empty operation. Free — no policy, no evidence, no payment. */
export async function createOperation(): Promise<CreatedOperation> {
  const operationId = generateOperationId()
  const recoveryCredential = generateRecoveryCredential()
  await createCommerceOperation({ operationId, recoveryCredentialHash: hashRecoveryCredential(recoveryCredential) })
  return { operationId, recoveryCredential }
}

/**
 * Constant-time credential check. Returns the operation record only when
 * BOTH the operation exists AND the supplied credential's hash matches —
 * never leaks which of the two failed (a wrong id and a wrong credential
 * for a real id return the identical `null`).
 */
export async function authenticateOperation(
  operationId: string,
  rawCredential: string | null | undefined,
  deps: { getOperation?: (id: string) => Promise<CommerceOperationRecord | null> } = {}
): Promise<CommerceOperationRecord | null> {
  if (!rawCredential) return null
  const op = await (deps.getOperation ?? getCommerceOperation)(operationId)
  if (!op) return null
  const suppliedHash = Buffer.from(hashRecoveryCredential(rawCredential), 'hex')
  const storedHash = Buffer.from(op.recoveryCredentialHash, 'hex')
  if (suppliedHash.length !== storedHash.length || !timingSafeEqual(suppliedHash, storedHash)) return null
  return op
}
