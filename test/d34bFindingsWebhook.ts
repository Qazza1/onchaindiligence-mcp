/** Focused D3.4B-2 webhook coverage. Run: npx tsx test/d34bFindingsWebhook.ts */
import assert from 'node:assert/strict'
import { emitFindingsUpdated, findingsRevision } from '../src/webhookEvents.js'
import type { CommerceObservationRecord, CommerceOperationRecord, LifecycleStepRow, WebhookEventRecord } from '../src/db.js'
import type { TaxonomyFinding } from '../src/contradictionTaxonomy.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const operation: CommerceOperationRecord = { operationId: 'OCD-OP-findings-webhook', recoveryCredentialHash: 'never-exposed', preflightState: 'completed', executionState: 'transaction_known', observationState: 'confirmed', receiptState: 'commerce_issued', preflightReceiptId: 'OCD-RCP-PRE', ownerId: 'OCD-ACC-owner', createdAt: '2026-09-10T00:00:00.000Z' }
const preflight: LifecycleStepRow = { operationId: operation.operationId, stepKey: 'preflight', inputDigest: 'sha256:input', status: 'completed', frozenInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: RECIPIENT }, policy: {} } }, capabilityToken: null, capabilityExpiresAt: null, resultJson: null }
function observation(recipient: string, amount = '1000'): CommerceObservationRecord {
  return { observationId: `obs-${recipient}`, operationId: operation.operationId, network: 'eip155:8453', blockNumber: '1', blockHash: '0xblock', transactionHash: '0xtx', logIndex: 0, observedPayer: null, observedRecipient: recipient, observedAmountAtomic: amount, tokenContract: USDC, paymentAuthorizer: null, paymentAuthorizationNonce: null, finalityPolicy: 'safe', finalityState: 'safe', chainHeadUsed: null, bindingStrength: 'EXECUTOR_CORRELATED', bundleDigest: 'sha256:bundle' }
}

const sameSetInDifferentOrder: TaxonomyFinding[] = [
  { finding_class: 'INSUFFICIENT_EVIDENCE', code: 'ATTRIBUTION_UNRESOLVED', explanation: 'x', evidence_refs: [], evidence_sources: [], expected: null, observed: null },
  { finding_class: 'CONTRADICTION', code: 'AMOUNT_MISMATCH', explanation: 'x', evidence_refs: [], evidence_sources: [], expected: null, observed: null },
]
assert.equal(findingsRevision(sameSetInDifferentOrder), findingsRevision([...sameSetInDifferentOrder].reverse()), 'revision is independent of input ordering')

let observed = [observation(OTHER, '1001')]
const events = new Map<string, WebhookEventRecord>()
const deps = {
  getCommerceOperation: async () => operation,
  getExecutionBindingsForOperation: async () => [],
  listCommerceObservations: async () => observed,
  getLifecycleStep: async () => preflight,
  createWebhookEvent: async (params: any) => {
    const key = `${params.operationId}\0${params.type}\0${params.dedupeKey}`
    const existing = events.get(key)
    if (existing) return { created: false, event: existing }
    const event: WebhookEventRecord = { eventId: `OCD-EVT-${events.size + 1}`, accountId: params.accountId, operationId: params.operationId, type: params.type, dedupeKey: params.dedupeKey, data: params.data, createdAt: '2026-09-10T00:00:00.000Z' }
    events.set(key, event)
    return { created: true, event }
  },
  createWebhookDelivery: async () => ({ created: true, delivery: {} as any }),
  listActiveWebhookEndpointsForAccount: async () => [],
}

await emitFindingsUpdated(operation.operationId, deps)
assert.equal(events.size, 1, 'a durable changed finding set enqueues one logical event')
const first = [...events.values()][0]
assert.equal(first.type, 'operation.findings_updated')
assert.deepEqual(first.data, { revision: first.dedupeKey, contradiction_count: 2, evidence_gap_count: 0 })

await emitFindingsUpdated(operation.operationId, deps)
assert.equal(events.size, 1, 're-deriving the same canonical set does not duplicate the logical event')

observed = [observation(RECIPIENT)]
await emitFindingsUpdated(operation.operationId, deps)
assert.equal(events.size, 2, 'a materially changed canonical set gets a new revision/event')
const second = [...events.values()][1]
assert.notEqual(second.dedupeKey, first.dedupeKey)
assert.deepEqual(second.data, { revision: second.dedupeKey, contradiction_count: 0, evidence_gap_count: 0 })

console.log('ok  D3.4B-2 emits deterministic, minimal findings changes once per canonical D3.3 revision')
