/** D2.4 (Section 2/11, acceptance criterion #13, Section 15 test #11):
 * durable operation identity + authenticated recovery.
 *
 * Run with: npx tsx test/d24Operation.ts
 *
 * Fully offline: injects a fake operation store via authenticateOperation's
 * own dependency seam -- no real Postgres, no network.
 */
import assert from 'node:assert/strict'
import { hashRecoveryCredential, authenticateOperation, isValidOperationIdFormat } from '../src/operation.js'
import type { CommerceOperationRecord } from '../src/db.js'

const OPERATION_ID = 'OCD-OP-' + 'A'.repeat(27)
const CORRECT_CREDENTIAL = 'correct-recovery-credential-value-0123456789'

function fakeOperation(): CommerceOperationRecord {
  return {
    operationId: OPERATION_ID,
    recoveryCredentialHash: hashRecoveryCredential(CORRECT_CREDENTIAL),
    preflightState: 'not_started',
    executionState: 'not_submitted',
    observationState: 'none',
    receiptState: 'none',
    preflightReceiptId: null,
    createdAt: new Date().toISOString(),
  }
}

// --- operation_id format -------------------------------------------------

assert.ok(isValidOperationIdFormat(OPERATION_ID))
assert.ok(!isValidOperationIdFormat('OCD-RCP-EMG6-6KR4-PQSG-MZPQ'), 'a receipt id must never validate as an operation id')
assert.ok(!isValidOperationIdFormat('not-an-operation-id'))
console.log('ok  operation ids are format-validated and distinguishable from receipt ids')

// --- authenticated recovery: correct credential -> authenticated ---------

{
  const op = await authenticateOperation(OPERATION_ID, CORRECT_CREDENTIAL, {
    getOperation: async (id) => (id === OPERATION_ID ? fakeOperation() : null),
  })
  assert.ok(op, 'the correct recovery credential for a real operation must authenticate')
  assert.equal(op!.operationId, OPERATION_ID)
}
console.log('ok  correct recovery credential authenticates the matching operation')

// --- D2.4 Section 15 test #11: wrong credential cannot read private state ---

{
  const op = await authenticateOperation(OPERATION_ID, 'a-completely-wrong-credential-value-000000', {
    getOperation: async () => fakeOperation(),
  })
  assert.equal(op, null, 'a wrong recovery credential must never authenticate, even for a real operation id')
}
console.log('ok  wrong recovery credential is rejected -- operation_id alone grants no access')

// --- unknown operation id -> null, indistinguishable from wrong credential ---

{
  const op = await authenticateOperation('OCD-OP-' + 'Z'.repeat(27), CORRECT_CREDENTIAL, {
    getOperation: async () => null,
  })
  assert.equal(op, null, 'an unknown operation id must never authenticate')
}
console.log('ok  unknown operation id is rejected the same way as a wrong credential (no information leak)')

// --- missing credential -> null, never treated as "no auth required" ------

{
  const op = await authenticateOperation(OPERATION_ID, undefined, { getOperation: async () => fakeOperation() })
  assert.equal(op, null, 'a missing credential must never authenticate')
  const op2 = await authenticateOperation(OPERATION_ID, '', { getOperation: async () => fakeOperation() })
  assert.equal(op2, null, 'an empty-string credential must never authenticate')
}
console.log('ok  a missing or empty recovery credential is always rejected')

console.log('\nAll D2.4 operation identity/recovery tests passed.')
