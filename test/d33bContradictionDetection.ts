/** Focused D3.3B runtime-adapter tests. Run: npx tsx test/d33bContradictionDetection.ts */
import assert from 'node:assert/strict'
import { detectContradictions } from '../src/contradictionDetection.js'
import { deriveFindings } from '../src/findings.js'
import type { Investigation } from '../src/investigation.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

type Bare = Omit<Investigation, 'findings'>

function investigation(overrides: Partial<Bare> = {}): Bare {
  return {
    operation: { operation_id: 'OCD-OP-test', created_at: '2026-09-10T10:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
    preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: { kind: 'PAYMENT', amount: '0.001', asset: USDC, network: 'eip155:8453', recipient: A, sender: null }, verification: { state: 'VALID', code: 'ok', message: 'ok' }, expected_payer: null },
    execution: { execution_request_id: 'OCD-EXEC-1', client_submission_key: 'key', executor_identity: 'executor', executor_version: 'v1', recovery_capability_class: 'none', provider_reference: 'provider-ref', submission_state: 'transaction_known', expected_payer: null, transaction_hash: '0xtx' },
    settlement: { network: 'eip155:8453', transaction_hash: '0xtx', block_hash: '0xblock', block_number: '1', log_index: 0, payer: null, recipient: A, asset: USDC, amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
    evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'EXECUTOR_CORRELATED', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: '0xtx', log_index: 0 }, observation_state: 'confirmed' },
    receipts: { preflight: null, commerce: null, verification: null },
    recovery: { needs_attention: false, may_already_have_paid: true, summary: 'complete', safe_next_action: 'none' },
    merchant_response: { evidence: [] },
    ...overrides,
  }
}

function context(policy: Record<string, unknown> = {}) {
  return { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: A }, policy } } }
}

function codes(inv: Bare, policy: Record<string, unknown> = {}): string[] { return detectContradictions(inv, context(policy)).map((f) => f.code) }
function has(inv: Bare, code: string, policy: Record<string, unknown> = {}): void { assert.ok(codes(inv, policy).includes(code), `expected ${code}; got ${codes(inv, policy).join(', ')}`) }
function lacks(inv: Bare, code: string, policy: Record<string, unknown> = {}): void { assert.ok(!codes(inv, policy).includes(code), `did not expect ${code}; got ${codes(inv, policy).join(', ')}`) }

// Current live evidence can establish mandate/observation comparisons.
lacks(investigation(), 'AMOUNT_MISMATCH')
has(investigation({ settlement: { ...investigation().settlement, amount_atomic: '1001' } }), 'AMOUNT_MISMATCH')
has(investigation({ settlement: { ...investigation().settlement, asset: B } }), 'ASSET_MISMATCH')
has(investigation({ settlement: { ...investigation().settlement, recipient: B } }), 'RECIPIENT_MISMATCH')
has(investigation({ settlement: { ...investigation().settlement, network: 'eip155:1' } }), 'NETWORK_MISMATCH')
has(investigation({ settlement: { ...investigation().settlement, amount_atomic: '1001' } }), 'POLICY_CONSTRAINT_VIOLATION', { max_amount: '0.000999' })
console.log('ok  current mandate, observation, and explicit-policy rules are runtime-active')

// Binding gate, normalization, and no-observation anti-spam.
const weakDifferentRecipient = investigation({ evidence: { ...investigation().evidence, binding_strength: 'TRANSFER_MATCH_ONLY' }, settlement: { ...investigation().settlement, recipient: B } })
has(weakDifferentRecipient, 'ATTRIBUTION_UNRESOLVED')
lacks(weakDifferentRecipient, 'RECIPIENT_MISMATCH')
lacks(investigation({ settlement: { ...investigation().settlement, recipient: A.toUpperCase().replace('0X', '0x') } }), 'RECIPIENT_MISMATCH')
lacks(investigation({ operation: { ...investigation().operation, execution_state: 'not_submitted' }, evidence: { ...investigation().evidence, event_identity: null, binding_strength: null }, settlement: { ...investigation().settlement, transaction_hash: null, recipient: null, asset: null, amount_atomic: null } }), 'REQUIRED_EVIDENCE_MISSING')
console.log('ok  weak/unrelated observations stay unresolved and never-submitted operations do not create finding spam')

// D3.3B's order is stable and its exact D2.8 duplicate is suppressed.
const multi = investigation({ settlement: { ...investigation().settlement, amount_atomic: '1001', recipient: B } })
const first = detectContradictions(multi, context({ max_amount: '0.000999' }))
const second = detectContradictions(multi, context({ max_amount: '0.000999' }))
assert.equal(JSON.stringify(first), JSON.stringify(second), 'repeated engine calls must serialize identically')
assert.deepEqual(first.map((f) => f.code), ['AMOUNT_MISMATCH', 'RECIPIENT_MISMATCH', 'POLICY_CONSTRAINT_VIOLATION'])

const legacyPlusD33 = deriveFindings(multi, context({ max_amount: '0.000999' }))
assert.equal(legacyPlusD33.filter((finding) => finding.code === 'AMOUNT_MISMATCH').length, 1, 'exact D2.8/D3.3 amount duplicates must collapse to one finding')
assert.ok(legacyPlusD33.some((finding) => finding.code === 'POLICY_CONSTRAINT_VIOLATION'), 'additive D3.3 policy finding must use the existing Finding shape')
assert.equal(legacyPlusD33.find((finding) => finding.code === 'AMOUNT_MISMATCH')?.finding_class, 'CONTRADICTION', 'taxonomy findings preserve their canonical finding_class')
assert.equal(legacyPlusD33.find((finding) => finding.code === 'RECEIPT_INVALID')?.finding_class ?? null, null, 'legacy findings remain explicitly classless')
console.log('ok  stable ordering, deterministic repeatability, and exact legacy-code deduplication')

// Dormant rules are not fabricated from current evidence.
for (const code of ['EXECUTION_STATUS_CONTRADICTION', 'SETTLEMENT_STATUS_CONTRADICTION', 'DUPLICATE_EXECUTION', 'PAYMENT_IDENTITY_MISMATCH', 'TEMPORAL_CONSTRAINT_VIOLATION']) {
  lacks(investigation(), code)
}
console.log('ok  unavailable execution, settlement, duplicate, payment-identity, and temporal evidence remains dormant')

console.log('\nAll D3.3B contradiction detection tests passed.')
