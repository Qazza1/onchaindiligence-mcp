/**
 * d28aFindings.ts — D2.8A findings/contradiction engine: focused coverage
 * per the task's Section 9 (4 items).
 *
 * Run with: npx tsx test/d28aFindings.ts
 *
 * deriveFindings() is a pure function -- these tests build minimal
 * Investigation-shaped fixtures directly (no DB, no HTTP, no D2.7A
 * plumbing) and assert on the exact findings produced.
 */
import assert from 'node:assert/strict'
import { deriveFindings, summarizeFindings } from '../src/findings.js'
import type { Investigation } from '../src/investigation.js'

type Bare = Omit<Investigation, 'findings'>

function baseInvestigation(overrides: Partial<Bare> = {}): Bare {
  return {
    operation: {
      operation_id: 'OCD-OP-' + 'F'.repeat(27),
      created_at: new Date().toISOString(),
      preflight_state: 'completed',
      execution_state: 'transaction_known',
      observation_state: 'confirmed',
      receipt_state: 'commerce_issued',
    },
    preflight: {
      receipt_id: 'OCD-RCP-PRE1',
      decision: 'ALLOW',
      action: { kind: 'PAYMENT', amount: '0.001', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', network: 'eip155:8453', recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea', sender: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846' },
      verification: { state: 'VALID', code: 'ok', message: 'verified' },
      // No frozen D2.4 policy.expected_payer commitment by default -- most
      // operations never set one (it's optional). Tests that need it set
      // override this explicitly.
      expected_payer: null,
    },
    execution: {
      execution_request_id: 'OCD-EXEC-1',
      client_submission_key: 'csk-1',
      executor_identity: 'paybox-x402-base-usdc',
      executor_version: 'v1-gateway',
      recovery_capability_class: 'stable-payment-identity',
      provider_reference: 'paybox:req-1',
      submission_state: 'transaction_known',
      expected_payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846',
      transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de',
    },
    settlement: {
      network: 'eip155:8453',
      transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de',
      block_hash: '0xblockhash',
      block_number: '50951350',
      log_index: 510,
      payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846',
      recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount_atomic: '1000',
      finality_state: 'safe',
      settlement_state: 'CONFIRMED',
    },
    evidence: {
      bundle_digest: 'sha256:evidencebundle',
      binding_strength: 'TRANSFER_MATCH_ONLY',
      event_identity: { network: 'eip155:8453', block_hash: '0xblockhash', transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de', log_index: 510 },
      observation_state: 'confirmed',
    },
    receipts: {
      preflight: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-PRE1' }, proof: {} } as any,
      commerce: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-COM1', settlement: { status: 'CONFIRMED' }, checks: [] }, proof: {} } as any,
      verification: { state: 'VALID', code: 'ok', message: 'verified' },
    },
    recovery: { needs_attention: false, may_already_have_paid: true, summary: 'A Commerce receipt has been issued for this operation.', safe_next_action: 'None -- this operation is complete.' },
    ...overrides,
  }
}

function withCommerceChecks(inv: Bare, checks: Array<{ id: string; result: string; summary: string }>): Bare {
  return { ...inv, receipts: { ...inv.receipts, commerce: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-COM1', settlement: { status: 'CONFIRMED' }, checks }, proof: {} } as any } }
}

// --- 1. healthy completed operation produces no false critical finding ----

{
  const findings = deriveFindings(baseInvestigation())
  const critical = findings.filter((f) => f.severity === 'critical')
  assert.equal(critical.length, 0, `a healthy, fully-confirmed operation must produce zero critical findings, got: ${critical.map((f) => f.code).join(', ')}`)
  // TRANSFER_MATCH_ONLY on an otherwise-healthy operation is expected to
  // surface as exactly one INFO finding, never a warning/critical.
  const weakAttribution = findings.find((f) => f.code === 'WEAK_ATTRIBUTION')
  assert.ok(weakAttribution, 'a confirmed settlement with TRANSFER_MATCH_ONLY must produce the WEAK_ATTRIBUTION info finding')
  assert.equal(weakAttribution.severity, 'info', 'WEAK_ATTRIBUTION must never be anything other than info -- it is not an error')
  const summary = summarizeFindings(findings)
  assert.match(summary, /1 informational/)
}
console.log('ok  a healthy, fully-confirmed completed operation produces zero false critical findings (only the expected informational TRANSFER_MATCH_ONLY note)')

// --- 2a. action.sender mismatch produces SENDER_MISMATCH (D2.8A correction) ---

{
  const inv = withCommerceChecks(baseInvestigation(), [
    { id: 'sender-matches-preflight', result: 'FAIL', summary: 'The observed sender does not match the sender required by the preflight.' },
  ])
  const findings = deriveFindings(inv)
  const finding = findings.find((f) => f.code === 'SENDER_MISMATCH')
  assert.ok(finding, 'a sender-matches-preflight FAIL must produce a SENDER_MISMATCH finding')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.category, 'settlement')
  assert.ok(finding.evidence_refs.includes('OCD-RCP-COM1'))
  // Claim discipline: state the contradiction, never an intent claim.
  assert.doesNotMatch(finding.summary + finding.title, /fraud|stolen|malicious/i)
  // This must NOT be conflated with EXPECTED_PAYER_MISMATCH -- no frozen
  // policy.expected_payer commitment was set in this fixture.
  assert.ok(!findings.some((f) => f.code === 'EXPECTED_PAYER_MISMATCH'), 'a bare action.sender mismatch must never also produce EXPECTED_PAYER_MISMATCH -- that is a distinct commitment')
}
console.log('ok  an action.sender mismatch (via the receipt\'s own sender-matches-preflight check) produces SENDER_MISMATCH, never EXPECTED_PAYER_MISMATCH')

// --- 2b. frozen policy.expected_payer mismatch produces EXPECTED_PAYER_MISMATCH (D2.8A correction) ---

{
  const inv = baseInvestigation({
    preflight: { ...baseInvestigation().preflight, expected_payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846' },
    settlement: { ...baseInvestigation().settlement, payer: '0x000000000000000000000000000000000000bAD' },
  })
  const findings = deriveFindings(inv)
  const finding = findings.find((f) => f.code === 'EXPECTED_PAYER_MISMATCH')
  assert.ok(finding, 'a frozen policy.expected_payer differing from the observed payer must produce EXPECTED_PAYER_MISMATCH')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.category, 'settlement')
  assert.doesNotMatch(finding.summary + finding.title, /fraud|stolen|malicious/i)
  assert.ok(!findings.some((f) => f.code === 'SENDER_MISMATCH'), 'this fixture\'s receipt checks are empty -- no SENDER_MISMATCH should be fabricated alongside it')

  // Null frozen expected_payer -> no finding, even with a clearly different observed payer.
  const noCommitment = deriveFindings(baseInvestigation({ settlement: { ...baseInvestigation().settlement, payer: '0x000000000000000000000000000000000000bAD' } }))
  assert.ok(!noCommitment.some((f) => f.code === 'EXPECTED_PAYER_MISMATCH'), 'with no frozen expected_payer commitment, no EXPECTED_PAYER_MISMATCH finding may be produced')

  // Observed payer unavailable -> no finding, even with a commitment set.
  const noObservedPayer = deriveFindings(
    baseInvestigation({
      preflight: { ...baseInvestigation().preflight, expected_payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846' },
      settlement: { ...baseInvestigation().settlement, payer: null },
    })
  )
  assert.ok(!noObservedPayer.some((f) => f.code === 'EXPECTED_PAYER_MISMATCH'), 'with no observed payer, no EXPECTED_PAYER_MISMATCH finding may be produced')
}
console.log('ok  a frozen policy.expected_payer differing from the independently observed payer produces EXPECTED_PAYER_MISMATCH; a null commitment or missing observed payer never does')

// --- 3. ambiguous execution produces an uncertainty/recovery finding ------

{
  const ambiguousMayHavePaid = deriveFindings(
    baseInvestigation({
      operation: { ...baseInvestigation().operation, execution_state: 'submission_ambiguous', receipt_state: 'none' },
      recovery: { needs_attention: true, may_already_have_paid: true, summary: 'A submission attempt was made but its outcome is not yet known.', safe_next_action: 'Resume this exact operation ... Never retry it as a new payment.' },
    })
  )
  const finding = ambiguousMayHavePaid.find((f) => f.code === 'EXECUTION_OUTCOME_UNCERTAIN')
  assert.ok(finding, 'submission_ambiguous must produce an EXECUTION_OUTCOME_UNCERTAIN finding')
  assert.equal(finding.severity, 'critical', 'when recovery says a payment may already have happened, this must be critical, not merely a warning')
  assert.equal(finding.recommended_action, 'Resume this exact operation ... Never retry it as a new payment.', 'the finding must reuse deriveRecoveryStatus()\'s own safe_next_action, not invent separate guidance')
  assert.doesNotMatch(finding.summary, /payment failed|fraud/i)

  const ambiguousNotYetPaid = deriveFindings(
    baseInvestigation({
      operation: { ...baseInvestigation().operation, execution_state: 'outcome_unknown', receipt_state: 'none' },
      recovery: { needs_attention: true, may_already_have_paid: false, summary: 'x', safe_next_action: 'y' },
    })
  )
  const finding2 = ambiguousNotYetPaid.find((f) => f.code === 'EXECUTION_OUTCOME_UNCERTAIN')
  assert.ok(finding2)
  assert.equal(finding2.severity, 'warning', 'when recovery says a payment has NOT necessarily already happened, this must be a warning, not critical')
}
console.log('ok  ambiguous execution produces EXECUTION_OUTCOME_UNCERTAIN, severity tracking whether a payment may already have happened, reusing D2.7A\'s recovery guidance verbatim')

// --- 4. invalid receipt produces the expected critical finding ------------

{
  const inv = baseInvestigation({ receipts: { ...baseInvestigation().receipts, verification: { state: 'INVALID', code: 'bad-signature', message: 'signature does not verify' } } })
  const findings = deriveFindings(inv)
  const finding = findings.find((f) => f.code === 'RECEIPT_INVALID')
  assert.ok(finding, 'a commerce receipt verifying INVALID must produce a RECEIPT_INVALID finding')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.category, 'receipt')
  assert.ok(finding.evidence_refs.includes('OCD-RCP-COM1'))
}
console.log('ok  a receipt that independently verifies INVALID produces the RECEIPT_INVALID critical finding')

console.log('\nAll D2.8A findings tests passed.')
