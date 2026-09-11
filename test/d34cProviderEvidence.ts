/** Focused D3.4C1 provider-claim and reconciliation tests. Fully offline. */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { parseProviderEvidenceInput, recordProviderEvidence, PROVIDER_EVIDENCE_SOURCE } from '../src/providerEvidence.js'
import { mountProviderEvidence } from '../src/providerEvidenceRoute.js'
import { detectContradictions } from '../src/contradictionDetection.js'
import type { Investigation } from '../src/investigation.js'
import type { CommerceOperationRecord, ExecutionBindingRecord, ProviderEvidenceRecord } from '../src/db.js'

const OP = 'OCD-OP-' + 'P'.repeat(27)
const EXEC = 'OCD-EXEC-provider-1'
const TX = '0x' + 'a'.repeat(64)
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

type Bare = Omit<Investigation, 'findings'>
function claim(state: 'SUCCEEDED' | 'FAILED', overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: 'sha256:provider', provider: 'x402-facilitator', provider_version: null, provider_execution_id: null,
    correlation_reference: 'payment-request-1', x402_version: '2', claimed_state: state, transaction_hash: TX,
    network: 'eip155:8453', payer: null, amount_atomic: '1000', asset: USDC, recipient: A, failure_code: state === 'FAILED' ? 'settlement-rejected' : null,
    source_authentication: PROVIDER_EVIDENCE_SOURCE, raw_reference_digest: 'sha256:' + 'b'.repeat(64), execution_request_id: EXEC,
    provider_event_id: null, provider_timestamp: null, recorded_at: '2026-09-11T00:00:00.000Z', ...overrides,
  } as const
}
function inv(overrides: Partial<Bare> = {}): Bare {
  return {
    operation: { operation_id: OP, created_at: '2026-09-11T00:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
    preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: null, verification: null, expected_payer: null },
    execution: { execution_request_id: EXEC, client_submission_key: 'key', executor_identity: 'x402', executor_version: 'v2', recovery_capability_class: 'none', provider_reference: 'provider-ref', submission_state: 'transaction_known', expected_payer: null, transaction_hash: TX },
    settlement: { network: 'eip155:8453', transaction_hash: TX, block_hash: '0xblock', block_number: '1', log_index: 0, payer: null, recipient: A, asset: USDC, amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
    evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: TX, log_index: 0 }, observation_state: 'confirmed' },
    receipts: { preflight: null, commerce: null, verification: null }, recovery: { needs_attention: false, may_already_have_paid: false, summary: '', safe_next_action: '' }, merchant_response: { evidence: [] },
    provider_evidence: { evidence: [claim('SUCCEEDED')] }, ...overrides,
  }
}
const context = { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: A }, policy: {} } } }
const codes = (value: Bare) => detectContradictions(value, context).map((f) => f.code)

// Standard x402 response is normalized; raw response itself is neither an
// accepted nor persisted field, only its supplied digest/reference is kept.
const parsed = parseProviderEvidenceInput({ x402_settle_response: { x402Version: 2, success: true, transaction: TX, network: 'eip155:8453', payer: A, amount: '1000' }, correlation_reference: 'payment-request-1', raw_reference_digest: 'sha256:' + 'c'.repeat(64), raw_response: 'never persisted' })
assert.equal(parsed.claimedState, 'SUCCEEDED')
assert.equal(parsed.x402Version, '2')
assert.equal(parsed.transactionHash, TX)
assert.equal((parsed as any).rawResponse, undefined)
console.log('ok  standard x402 facilitator response is normalized without storing raw response material')

// A: provider success + matching independent observation.
assert.ok(!codes(inv()).some((code) => code.includes('STATUS_') || code.includes('INDEPENDENTLY_')), codes(inv()).join(', '))
// B: provider success + no independent observation creates the existing,
// precise settlement evidence gap (not a fake matching observation).
const missing = inv({ evidence: { ...inv().evidence, event_identity: null, binding_strength: null, observation_state: 'none' }, settlement: { ...inv().settlement, transaction_hash: null, block_hash: null, block_number: null, log_index: null, recipient: null, asset: null, amount_atomic: null, settlement_state: null } })
assert.ok(codes(missing).includes('SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED'), codes(missing).join(', '))
// C: provider success never overrides an independently observed mismatch.
const mismatch = inv({ evidence: { ...inv().evidence, binding_strength: 'EXECUTOR_CORRELATED' }, settlement: { ...inv().settlement, amount_atomic: '1001', recipient: B } })
assert.ok(codes(mismatch).includes('AMOUNT_MISMATCH'))
assert.ok(codes(mismatch).includes('RECIPIENT_MISMATCH'))
// D: provider failure and an independently observed settlement disagree.
const failed = inv({ provider_evidence: { evidence: [claim('FAILED')] } })
assert.ok(codes(failed).includes('EXECUTION_STATUS_CONTRADICTION'), codes(failed).join(', '))
assert.ok(codes(failed).includes('SETTLEMENT_STATUS_CONTRADICTION'), codes(failed).join(', '))
// A provider-supplied transaction hash does not strengthen TRANSFER_MATCH_ONLY.
assert.equal(inv().evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
assert.ok(codes(inv()).includes('ATTRIBUTION_UNRESOLVED'), 'provider claim must not upgrade binding strength')
console.log('ok  provider success/missing/mismatch/failure reconciliation uses existing D3.3 codes and never upgrades binding')

const binding: ExecutionBindingRecord = { executionRequestId: EXEC, operationId: OP, clientSubmissionKey: 'key', executorIdentity: 'x402', executorVersion: 'v2', recoveryCapabilityClass: 'none', frozenPreflightReceiptId: 'r', frozenPreflightReceiptDigest: 'd', expectedPayer: null, providerReference: 'provider-ref', submissionState: 'transaction_known' }
const rows = new Map<string, ProviderEvidenceRecord>()
const store = {
  getExecutionBinding: async (id: string) => id === EXEC ? binding : null,
  createProviderEvidence: async (params: any) => {
    const existing = rows.get(params.evidenceId)
    if (existing) return { created: false, evidence: existing }
    const evidence: ProviderEvidenceRecord = { ...params, recordedAt: '2026-09-11T00:00:00.000Z' }
    rows.set(params.evidenceId, evidence)
    return { created: true, evidence }
  },
}
const first = await recordProviderEvidence(OP, { ...parsed, executionRequestId: EXEC }, store)
const second = await recordProviderEvidence(OP, { ...parsed, executionRequestId: EXEC }, store)
assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.evidence.sourceAuthentication, PROVIDER_EVIDENCE_SOURCE)
const app = new Hono()
mountProviderEvidence(app, { authenticateOperation: async () => ({ operationId: OP } as CommerceOperationRecord), emitFindingsUpdated: async () => {}, ...store } as any)
const response = await app.request(`/operations/${OP}/provider-evidence`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocd-recovery-credential': 'test' }, body: JSON.stringify({ x402_settle_response: { success: false, error: 'declined' }, execution_request_id: EXEC }) })
assert.equal(response.status, 201)
console.log('ok  provider claims are append-only/idempotent, operation-bound, and available through the existing operation surface')
