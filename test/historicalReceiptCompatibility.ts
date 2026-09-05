/** D2.3 (Task 10): backward-compatibility gate for the four production
 * receipts named explicitly in the D2.3 task -- existing signed v1 receipts
 * MUST remain immutable AND must keep verifying VALID (proof), regardless
 * of their execution/settlement status, under the current verifier.
 *
 * Run with: npx tsx test/historicalReceiptCompatibility.ts
 *
 * Fully offline: uses a frozen snapshot (test/fixtures-historical-receipts.json)
 * of the real envelopes + the live key registry, captured once from
 * production. This deliberately does NOT hit the network on every CI run --
 * a live check was also run manually and is reported in the D2.3 report.
 * If this snapshot ever needs refreshing, re-run against production and
 * confirm the SAME states below before overwriting it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { verifyReceiptEnvelope, type PublicActionReceiptEnvelope } from '../src/receipts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures-historical-receipts.json'), 'utf8')) as {
  envelopes: PublicActionReceiptEnvelope[]
  registry: any[]
}

const EXPECTED = {
  'OCD-RCP-EMG6-6KR4-PQSG-MZPQ': { label: 'reference ACTION receipt', receipt_type: 'ACTION', execution: 'NOT_SUBMITTED', settlement: 'NOT_APPLICABLE' },
  'OCD-RCP-VZC7-XPV2-NMGC-EH1K': { label: 'real PREFLIGHT receipt', receipt_type: 'PREFLIGHT', execution: 'NOT_SUBMITTED', settlement: 'NOT_APPLICABLE' },
  'OCD-RCP-3HP5-CSBH-EGH9-PCNK': { label: 'historical Commerce receipt (transient RPC failure at mint time)', receipt_type: 'COMMERCE', execution: 'UNKNOWN', settlement: 'UNVERIFIED' },
  'OCD-RCP-ASER-TH5K-ZN3B-TVC5': { label: 'reconciled Commerce receipt', receipt_type: 'COMMERCE', execution: 'CONFIRMED', settlement: 'CONFIRMED' },
} as const

assert.equal(fixture.envelopes.length, 4, 'fixture must contain exactly the four named historical receipts')

for (const envelope of fixture.envelopes) {
  const id = envelope.receipt.receipt_id
  const expected = EXPECTED[id as keyof typeof EXPECTED]
  assert.ok(expected, `unexpected receipt id in fixture: ${id}`)

  assert.equal(envelope.receipt.receipt_type, expected.receipt_type, `${expected.label}: receipt_type must not have changed`)
  assert.equal(envelope.receipt.execution.status, expected.execution, `${expected.label}: execution.status must not have changed`)
  assert.equal(envelope.receipt.settlement.status, expected.settlement, `${expected.label}: settlement.status must not have changed`)

  // The core acceptance criterion: PROOF is independent of what the receipt
  // reports. Every one of these, including the historical UNKNOWN/UNVERIFIED
  // receipt, must verify VALID -- a valid signature over an honest "we don't
  // know yet" result is exactly the intended behavior, not a bug.
  const verification = verifyReceiptEnvelope(envelope, fixture.registry)
  assert.equal(verification.state, 'VALID', `${expected.label} (${id}) must still verify VALID: got ${verification.state} (${verification.code}: ${verification.message})`)

  console.log(`ok  ${expected.label} (${id}): receipt_type=${expected.receipt_type} execution=${expected.execution} settlement=${expected.settlement} -> proof VALID`)
}

// The historical UNKNOWN/UNVERIFIED receipt and its later reconciliation
// must never be confused with each other -- neither implies the other is
// wrong, and both remain independently, permanently resolvable.
const historical = fixture.envelopes.find((e) => e.receipt.receipt_id === 'OCD-RCP-3HP5-CSBH-EGH9-PCNK')!
const reconciled = fixture.envelopes.find((e) => e.receipt.receipt_id === 'OCD-RCP-ASER-TH5K-ZN3B-TVC5')!
assert.notEqual(historical.receipt.receipt_digest, reconciled.receipt.receipt_digest, 'the historical and reconciled receipts must be genuinely distinct content')
const priorObservationCheck = reconciled.receipt.checks.find((c) => c.id === 'prior-commerce-observation')
assert.ok(priorObservationCheck, 'the reconciled receipt must carry a prior-commerce-observation check linking back to the historical one')
assert.equal(priorObservationCheck?.evidence_digest, historical.receipt.receipt_digest, "the reconciliation's evidence_digest must point at the historical receipt's own digest")
console.log('ok  the historical and reconciled receipts are linked via prior-commerce-observation, neither rewritten')

console.log('\nAll D2.3 historical receipt compatibility checks passed.')
