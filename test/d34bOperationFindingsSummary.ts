/** Focused D3.4B-1 list-summary coverage. Run: npx tsx test/d34bOperationFindingsSummary.ts */
import assert from 'node:assert/strict'
import { deriveFindingsSummary } from '../src/operationHistory.js'
import type { CommerceOperationRecord, CommerceObservationRecord } from '../src/db.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const operation: CommerceOperationRecord = {
  operationId: 'OCD-OP-summary', recoveryCredentialHash: 'never-returned', preflightState: 'completed', executionState: 'transaction_known',
  observationState: 'confirmed', receiptState: 'commerce_issued', preflightReceiptId: 'OCD-RCP-PRE', ownerId: 'OCD-ACC-owner', createdAt: '2026-09-10T00:00:00.000Z',
}
const observation: CommerceObservationRecord = {
  observationId: 'obs-1', operationId: operation.operationId, network: 'eip155:8453', blockNumber: '1', blockHash: '0xblock', transactionHash: '0xtx', logIndex: 0,
  observedPayer: null, observedRecipient: OTHER, observedAmountAtomic: '1001', tokenContract: USDC, paymentAuthorizer: null, paymentAuthorizationNonce: null,
  finalityPolicy: 'safe', finalityState: 'safe', chainHeadUsed: null, bindingStrength: 'EXECUTOR_CORRELATED', bundleDigest: 'sha256:bundle',
}
const preflight = { frozenInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: RECIPIENT }, policy: { max_amount: '0.000999' } } } }

assert.equal(deriveFindingsSummary(operation, undefined, [], []), null, 'legacy operations without a durable preflight journal remain explicitly unavailable')
assert.deepEqual(deriveFindingsSummary(operation, preflight, [], []), { contradiction_count: 0, evidence_gap_count: 0, evaluated: false }, 'a preflight without an observation is not silently presented as a clean reconciliation')
assert.deepEqual(deriveFindingsSummary(operation, preflight, [], [observation]), { contradiction_count: 3, evidence_gap_count: 0, evaluated: true }, 'observed mandate mismatches are counted from D3.3 taxonomy findings only')

console.log('ok  D3.4B-1 list summaries are null for legacy operations, explicit before observation, and taxonomy-derived after reconciliation')
