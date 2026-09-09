/** Focused D3.3A rule-matrix tests. Run: npx tsx test/d33aContradictionTaxonomy.ts */
import assert from 'node:assert/strict'
import { deriveTaxonomyFindings, normalizeAtomicAmount, normalizeEvmAddress, normalizeNetwork, type ReconciliationFacts } from '../src/contradictionTaxonomy.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OTHER = '0x3333333333333333333333333333333333333333'

function base(overrides: Partial<ReconciliationFacts> = {}): ReconciliationFacts {
  return {
    attribution: 'ATTRIBUTED',
    evidence_refs: ['obs:base:0xabc:1', 'mandate:OCD-RCP-1'],
    mandate: { amount_atomic: '1000', asset: USDC, recipient: A, network: 'eip155:8453', payment_identity: 'payment-A', deadline: '2026-09-10T12:00:00Z' },
    observation: { amount_atomic: '1000', asset: USDC.toLowerCase(), recipient: A, network: 'eip155:8453', payment_identity: 'payment-A', execution_at: '2026-09-10T11:00:00Z', execution_ids: ['eip155:8453:0xtx:1'] },
    ...overrides,
  }
}

function codes(facts: ReconciliationFacts): string[] { return deriveTaxonomyFindings(facts).map((finding) => finding.code) }
function has(facts: ReconciliationFacts, code: string): void { assert.ok(codes(facts).includes(code), `expected ${code}; got ${codes(facts).join(', ')}`) }
function lacks(facts: ReconciliationFacts, code: string): void { assert.ok(!codes(facts).includes(code), `did not expect ${code}; got ${codes(facts).join(', ')}`) }

// Ten positive contradiction cases.
has(base({ observation: { ...base().observation, amount_atomic: '1001' } }), 'AMOUNT_MISMATCH')
has(base({ observation: { ...base().observation, asset: OTHER } }), 'ASSET_MISMATCH')
has(base({ observation: { ...base().observation, recipient: B } }), 'RECIPIENT_MISMATCH')
has(base({ observation: { ...base().observation, network: 'eip155:1' } }), 'NETWORK_MISMATCH')
has(base({ policy: { max_amount_atomic: '999' } }), 'POLICY_CONSTRAINT_VIOLATION')
has(base({ executor_claim: { execution_status: 'CONFIRMED' }, independent: { execution_status: 'FAILED' } }), 'EXECUTION_STATUS_CONTRADICTION')
has(base({ executor_claim: { settlement_status: 'CONFIRMED' }, independent: { settlement_status: 'NOT_CONFIRMED' } }), 'SETTLEMENT_STATUS_CONTRADICTION')
has(base({ only_one_execution_authorized: true, observation: { ...base().observation, execution_ids: ['eip155:8453:0xtx:1', 'eip155:8453:0xtx:2'] } }), 'DUPLICATE_EXECUTION')
has(base({ observation: { ...base().observation, payment_identity: 'payment-B' } }), 'PAYMENT_IDENTITY_MISMATCH')
has(base({ observation: { ...base().observation, execution_at: '2026-09-10T12:00:01Z' } }), 'TEMPORAL_CONSTRAINT_VIOLATION')
console.log('ok  ten positive contradiction rules')

// Five uncertainty cases: absent, weak, or unresolved data is never upgraded to contradiction.
has(base({ executor_claim: { execution_status: 'CONFIRMED' }, independent: {} }), 'EXECUTION_NOT_INDEPENDENTLY_OBSERVED')
has(base({ executor_claim: { settlement_status: 'CONFIRMED' }, independent: { settlement_status: 'UNVERIFIED' } }), 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED')
has(base({ observation: { ...base().observation, payment_identity: undefined }, binding_strength: 'TRANSFER_MATCH_ONLY' }), 'PAYMENT_IDENTITY_UNRESOLVED')
has(base({ attribution: 'UNRESOLVED', observation: { ...base().observation, recipient: B } }), 'ATTRIBUTION_UNRESOLVED')
has(base({ observation: { ...base().observation, amount_atomic: undefined } }), 'REQUIRED_EVIDENCE_MISSING')
console.log('ok  five insufficient-evidence rules')

// False-positive protections required by the D3.3A brief.
lacks(base({ observation: { ...base().observation, recipient: A.toUpperCase().replace('0X', '0x') } }), 'RECIPIENT_MISMATCH')
lacks(base({ observation: { ...base().observation, amount_atomic: '1000' } }), 'AMOUNT_MISMATCH')
lacks(base({ only_one_execution_authorized: true, observation: { ...base().observation, execution_ids: ['same-tx', 'same-tx'] } }), 'DUPLICATE_EXECUTION')
const delayed = base({ executor_claim: { execution_status: 'CONFIRMED' }, independent: {} })
lacks(delayed, 'EXECUTION_STATUS_CONTRADICTION')
const unrelated = base({ attribution: 'UNRESOLVED', observation: { ...base().observation, recipient: B } })
lacks(unrelated, 'RECIPIENT_MISMATCH')
lacks(base({ executor_claim: { execution_status: 'UNKNOWN' }, independent: { execution_status: 'UNKNOWN' } }), 'EXECUTION_STATUS_CONTRADICTION')
lacks(base({ receipt_verification: 'UNVERIFIABLE' }), 'SETTLEMENT_STATUS_CONTRADICTION')
lacks(base({ observation: { ...base().observation, payment_identity: undefined }, binding_strength: 'TRANSFER_MATCH_ONLY' }), 'PAYMENT_IDENTITY_MISMATCH')
lacks(base({ executor_claim: { execution_status: 'NOT_SUBMITTED' } }), 'POLICY_CONSTRAINT_VIOLATION') // ALLOW/no execution is not a violation.
console.log('ok  false-positive protections')

// Deterministic normalizers: no float conversion, checksum-only address difference, and no display-network guessing.
assert.equal(normalizeAtomicAmount('1000'), 1000n)
assert.equal(normalizeAtomicAmount('1.0'), null)
assert.equal(normalizeEvmAddress(USDC), USDC.toLowerCase())
assert.equal(normalizeNetwork('eip155:8453'), 'eip155:8453')
assert.equal(normalizeNetwork('Base'), null)
assert.deepEqual(codes(base({ evidence_refs: ['z', 'a', 'z'] })), codes(base({ evidence_refs: ['a', 'z'] })))
console.log('ok  deterministic canonical normalization and ordering')

console.log('\nAll D3.3A contradiction taxonomy tests passed.')
