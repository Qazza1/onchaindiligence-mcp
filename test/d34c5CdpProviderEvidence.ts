/** Focused D3.4C5 Coinbase/CDP provider-evidence + reconciliation tests. Fully offline -- CDP has no webhook; evidence arrives caller-reported through the existing recovery-credential-gated endpoint, exactly like PayBox. */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { parseProviderEvidenceInput, recordProviderEvidence, CDP_EXECUTOR_IDENTITY } from '../src/providerEvidence.js'
import { mountProviderEvidence } from '../src/providerEvidenceRoute.js'
import { detectContradictions } from '../src/contradictionDetection.js'
import type { Investigation } from '../src/investigation.js'
import type { CommerceOperationRecord, ExecutionBindingRecord, ProviderEvidenceRecord } from '../src/db.js'

const OP = 'OCD-OP-' + 'D'.repeat(27)
const EXEC = 'OCD-EXEC-cdp-1'
const TX = '0x' + 'a'.repeat(64)
const A = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const IDEMPOTENCY_KEY = 'idem-attempt-1'

// --- 1: terminal CDP success normalizes correctly ---
{
  const parsed = parseProviderEvidenceInput({
    execution_request_id: EXEC,
    provider_timestamp: '2026-09-11T00:00:00.000Z',
    cdp_response: { status: 'success', transaction_hash: TX, network: 'base', idempotency_key: IDEMPOTENCY_KEY },
  })
  assert.equal(parsed.provider, 'cdp')
  assert.equal(parsed.providerExecutionId, TX)
  assert.equal(parsed.correlationReference, `cdp:${TX}`)
  assert.equal(parsed.claimedState, 'SUCCEEDED')
  assert.equal(parsed.transactionHash, TX)
  assert.equal(parsed.network, 'eip155:8453')
  // CDP's sendEvmTransaction response asserts nothing about payer/amount/asset/recipient -- must stay null.
  assert.equal(parsed.payer, null)
  assert.equal(parsed.amountAtomic, null)
  assert.equal(parsed.asset, null)
  assert.equal(parsed.recipient, null)
  console.log('ok  a terminal CDP success (transaction_hash present) normalizes into ProviderEvidenceInput without asserting fields CDP does not document')
}

// --- 2: terminal CDP failure normalizes correctly (broadcast never happened, no transaction_hash) ---
{
  const parsed = parseProviderEvidenceInput({
    execution_request_id: EXEC,
    cdp_response: { status: 'failed', network: 'base', idempotency_key: IDEMPOTENCY_KEY, error: { code: 'insufficient_funds', message: 'insufficient balance for gas * price + value' } },
  })
  assert.equal(parsed.provider, 'cdp')
  assert.equal(parsed.claimedState, 'FAILED')
  assert.equal(parsed.transactionHash, null)
  // With no transaction_hash, the caller-supplied idempotency key is the only identity CDP confirms for this attempt.
  assert.equal(parsed.providerExecutionId, IDEMPOTENCY_KEY)
  assert.equal(parsed.correlationReference, `cdp:${IDEMPOTENCY_KEY}`)
  assert.equal(parsed.failureCode, 'insufficient_funds')
  assert.match(parsed.failureDigest!, /^sha256:/)
  console.log('ok  a terminal CDP failure (never broadcast) normalizes correctly, using the idempotency key as the attempt identity since no transaction hash exists')

  assert.throws(() => parseProviderEvidenceInput({ cdp_response: { status: 'pending', network: 'base' } }), /status must be success or failed/)
  console.log('ok  a non-terminal/pending CDP status is never accepted as terminal provider evidence')
}

// --- identity discipline: providerExecutionId is exactly the transaction hash for a successful EOA send -- never a hypothetical userOpHash ---
{
  const withDecoy = parseProviderEvidenceInput({
    execution_request_id: EXEC,
    cdp_response: { status: 'success', transaction_hash: TX, network: 'base', userOpHash: '0x' + 'f'.repeat(64) }, // if a caller mistakenly includes this Smart-Account-only field, it must never leak into the identity
  })
  assert.equal(withDecoy.providerExecutionId, TX)
  assert.equal(withDecoy.transactionHash, TX)
  console.log('ok  providerExecutionId/transactionHash come only from transaction_hash; a hypothetical userOpHash field is never substituted in')
}

// --- unmapped chain identifiers are left null, never guessed ---
{
  const parsed = parseProviderEvidenceInput({ cdp_response: { status: 'success', transaction_hash: TX, network: 'polygon' } })
  assert.equal(parsed.network, null, 'an unmapped CDP chain identifier must never be guessed into a CAIP-2 network')
  console.log('ok  a CDP chain identifier outside the confirmed base->eip155:8453 mapping is left null, never guessed')
}

// --- 3/4: reconciliation reuses existing D3.3 codes, no CDP-specific taxonomy ---
{
  type Bare = Omit<Investigation, 'findings'>
  function cdpClaim(state: 'SUCCEEDED' | 'FAILED') {
    return {
      evidence_id: 'sha256:cdp', provider: 'cdp', provider_version: null, provider_execution_id: state === 'SUCCEEDED' ? TX : IDEMPOTENCY_KEY,
      correlation_reference: `cdp:${state === 'SUCCEEDED' ? TX : IDEMPOTENCY_KEY}`, x402_version: null, claimed_state: state, transaction_hash: state === 'SUCCEEDED' ? TX : null,
      network: 'eip155:8453', payer: null, amount_atomic: null, asset: null, recipient: null, failure_code: state === 'FAILED' ? 'CDP_SEND_FAILED' : null,
      source_authentication: 'CALLER_REPORTED_PROVIDER_RESPONSE', raw_reference_digest: 'sha256:' + 'd'.repeat(64), execution_request_id: EXEC,
      provider_event_id: null, provider_timestamp: null, recorded_at: '2026-09-11T00:00:00.000Z',
    } as const
  }
  function inv(overrides: Partial<Bare> = {}): Bare {
    return {
      operation: { operation_id: OP, created_at: '2026-09-11T00:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
      preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: null, verification: null, expected_payer: null },
      execution: { execution_request_id: EXEC, client_submission_key: 'key', executor_identity: CDP_EXECUTOR_IDENTITY, executor_version: 'v1', recovery_capability_class: 'stable-payment-identity', provider_reference: `cdp:${TX}`, submission_state: 'transaction_known', expected_payer: null, transaction_hash: TX },
      settlement: { network: 'eip155:8453', transaction_hash: TX, block_hash: '0xblock', block_number: '1', log_index: 0, payer: null, recipient: A, asset: USDC, amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
      evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: TX, log_index: 0 }, observation_state: 'confirmed' },
      receipts: { preflight: null, commerce: null, verification: null }, recovery: { needs_attention: false, may_already_have_paid: false, summary: '', safe_next_action: '' }, merchant_response: { evidence: [] },
      provider_evidence: { evidence: [cdpClaim('SUCCEEDED')] }, ...overrides,
    }
  }
  const context = { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: A }, policy: {} } } }
  const codes = (value: Bare) => detectContradictions(value, context).map((f) => f.code)

  // 3: success + matching independent Base observation -> reconciled, no contradiction codes.
  assert.ok(!codes(inv()).some((c) => c.includes('STATUS_')), codes(inv()).join(', '))
  console.log('ok  CDP success + matching independent observation reconciles using existing D3.3 behavior, no CDP-specific code')

  // 4: failure + OCD independently observes settlement anyway -> existing contradiction codes.
  const failed = inv({ provider_evidence: { evidence: [cdpClaim('FAILED')] } })
  assert.ok(codes(failed).includes('EXECUTION_STATUS_CONTRADICTION'), codes(failed).join(', '))
  assert.ok(codes(failed).includes('SETTLEMENT_STATUS_CONTRADICTION'), codes(failed).join(', '))
  console.log('ok  CDP failure + an independently observed settlement produces the existing execution/settlement contradiction codes')

  // amount mismatch -> existing AMOUNT_MISMATCH (bumping binding_strength to EXECUTOR_CORRELATED mirrors the established pattern for mismatch tests -- see D3.4C4)
  const mismatch = inv({ evidence: { ...inv().evidence, binding_strength: 'EXECUTOR_CORRELATED' }, settlement: { ...inv().settlement, amount_atomic: '2000' } })
  assert.ok(codes(mismatch).includes('AMOUNT_MISMATCH'), codes(mismatch).join(', '))
  console.log('ok  an observed amount mismatch produces the existing AMOUNT_MISMATCH code, no CDP-specific taxonomy')

  // 5: a CDP claim never upgrades binding strength.
  assert.equal(inv().evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.ok(codes(inv()).includes('ATTRIBUTION_UNRESOLVED'), 'a CDP provider claim must not upgrade binding strength on its own')
  console.log('ok  a CDP provider claim never upgrades binding strength; commerceLifecycle.ts remains untouched and authoritative')
}

// --- 5: durable provider-reference correlation works; unmatched evidence is not attached to an arbitrary operation ---
{
  const parsed = parseProviderEvidenceInput({ execution_request_id: EXEC, cdp_response: { status: 'success', transaction_hash: TX, network: 'base' } })
  const binding: ExecutionBindingRecord = { executionRequestId: EXEC, operationId: OP, clientSubmissionKey: 'key', executorIdentity: CDP_EXECUTOR_IDENTITY, executorVersion: 'v1', recoveryCapabilityClass: 'stable-payment-identity', frozenPreflightReceiptId: 'r', frozenPreflightReceiptDigest: 'd', expectedPayer: null, providerReference: `cdp:${TX}`, submissionState: 'transaction_known' }
  const rows = new Map<string, ProviderEvidenceRecord>()
  const store = {
    getExecutionBinding: async (id: string) => (id === EXEC ? binding : null),
    createProviderEvidence: async (params: any) => {
      const existing = rows.get(params.evidenceId)
      if (existing) return { created: false, evidence: existing }
      const evidence: ProviderEvidenceRecord = { ...params, recordedAt: '2026-09-11T00:00:00.000Z' }
      rows.set(params.evidenceId, evidence)
      return { created: true, evidence }
    },
  }
  const result = await recordProviderEvidence(OP, parsed, store)
  assert.equal(result.created, true)
  assert.equal(result.evidence.provider, 'cdp')
  const replay = await recordProviderEvidence(OP, parsed, store)
  assert.equal(replay.created, false)
  console.log('ok  CDP evidence correlates through the durable execution binding and is idempotent on replay')

  await assert.rejects(
    () => recordProviderEvidence(OP, { ...parsed, correlationReference: 'cdp:decoy' }, store),
    /does not match the durable execution binding/
  )
  await assert.rejects(
    () => recordProviderEvidence(OP, parsed, { ...store, getExecutionBinding: async () => ({ ...binding, executorIdentity: 'x402' }) }),
    /requires a CDP execution binding/
  )
  console.log('ok  CDP evidence is rejected when it does not match the durable execution binding, never attached to an unrelated one')

  const app = new Hono()
  mountProviderEvidence(app, { authenticateOperation: async () => ({ operationId: OP } as CommerceOperationRecord), emitFindingsUpdated: async () => {}, ...store } as any)
  const response = await app.request(`/operations/${OP}/provider-evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ocd-recovery-credential': 'test' },
    body: JSON.stringify({ execution_request_id: EXEC, cdp_response: { status: 'failed', network: 'base', idempotency_key: 'idem-x', error: { code: 'timeout' } } }),
  })
  assert.equal(response.status, 400, 'a CDP failure using a NEW idempotency key not matching the durable binding provider_reference must be rejected, never guessed onto this operation')
  console.log('ok  CDP evidence reaches the existing operation surface and correlation is enforced end-to-end through the real route')
}
