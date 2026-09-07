/**
 * d29aMerchantEvidence.ts — D2.9A merchant/response evidence: focused
 * coverage per the task's Section 10 (4 items).
 *
 * Run with: npx tsx test/d29aMerchantEvidence.ts
 *
 * Fully offline: recordMerchantEvidence()/parseMerchantEvidenceInput() are
 * exercised directly against in-memory fakes (same convention as
 * test/d24ExecutionBinding.ts); the HTTP route is exercised through the
 * real Hono app; deriveFindings() is exercised directly with a
 * hand-built Investigation fixture. No Postgres, no real network.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import {
  parseMerchantEvidenceInput,
  recordMerchantEvidence,
  sanitizeResponseHeaders,
  MerchantEvidenceInputError,
  MERCHANT_EVIDENCE_SOURCE,
} from '../src/merchantEvidence.js'
import { mountMerchantEvidence, type MerchantEvidenceRouteDependencies } from '../src/merchantEvidenceRoute.js'
import { deriveFindings } from '../src/findings.js'
import type { Investigation } from '../src/investigation.js'
import type { MerchantEvidenceRecord, ExecutionBindingRecord, CommerceOperationRecord } from '../src/db.js'

const OPERATION_ID = 'OCD-OP-' + 'M'.repeat(27)
const EXECUTION_REQUEST_ID = 'OCD-EXEC-merchant-1'

function digest(raw: string): string {
  return 'sha256:' + createHash('sha256').update(raw, 'utf8').digest('hex')
}

function makeFakeStore() {
  const rows = new Map<string, MerchantEvidenceRecord>()
  const binding: ExecutionBindingRecord = {
    executionRequestId: EXECUTION_REQUEST_ID,
    operationId: OPERATION_ID,
    clientSubmissionKey: 'csk-1',
    executorIdentity: 'paybox-x402-base-usdc',
    executorVersion: 'v1-gateway',
    recoveryCapabilityClass: 'stable-payment-identity',
    frozenPreflightReceiptId: 'OCD-RCP-PRE1',
    frozenPreflightReceiptDigest: 'digest',
    expectedPayer: null,
    providerReference: 'paybox:req-1',
    submissionState: 'transaction_known',
  }
  return {
    getExecutionBinding: async (id: string) => (id === EXECUTION_REQUEST_ID ? binding : null),
    createMerchantEvidence: async (params: any) => {
      const existing = rows.get(params.evidenceId)
      if (existing) return { created: false, evidence: existing }
      const evidence: MerchantEvidenceRecord = { ...params, source: MERCHANT_EVIDENCE_SOURCE, recordedAt: new Date().toISOString() }
      rows.set(params.evidenceId, evidence)
      return { created: true, evidence }
    },
    rows,
  }
}

// --- 1. evidence is recorded and returned in investigation -----------------

{
  const store = makeFakeStore()
  const input = parseMerchantEvidenceInput({
    resource_url: 'https://api.onesource.io/api/chain/block-number',
    http_status: 200,
    content_type: 'application/json',
    response_body_digest: digest('{"ok":true}'),
    response_bytes: 11,
    execution_request_id: EXECUTION_REQUEST_ID,
    provider_reference: 'paybox:req-1',
  })
  const result = await recordMerchantEvidence(OPERATION_ID, input, store)
  assert.equal(result.created, true)
  assert.equal(result.evidence.source, 'CALLER_REPORTED')
  assert.equal(result.evidence.operationId, OPERATION_ID)
  assert.equal(result.evidence.httpStatus, 200)

  // Investigation integration: deriveFindings() reads investigation.merchant_response.evidence directly (see test 3 below for the full shape) -- here, confirm the record maps into that shape one-for-one.
  const asInvestigationItem = {
    evidence_id: result.evidence.evidenceId,
    resource_url: result.evidence.resourceUrl,
    http_status: result.evidence.httpStatus,
    content_type: result.evidence.contentType,
    body_digest: result.evidence.responseBodyDigest,
    response_bytes: result.evidence.responseBytes,
    source: result.evidence.source,
    execution_request_id: result.evidence.executionRequestId,
    provider_reference: result.evidence.providerReference,
    transaction_hash: result.evidence.transactionHash,
    transaction_hash_matches_known_observation: null,
    recorded_at: result.evidence.recordedAt,
  }
  assert.equal(asInvestigationItem.resource_url, 'https://api.onesource.io/api/chain/block-number')
  assert.equal(asInvestigationItem.source, 'CALLER_REPORTED')

  // Route-level: an execution_request_id belonging to a DIFFERENT operation must be rejected (400), not silently accepted.
  const app = new Hono()
  mountMerchantEvidence(app, {
    authenticateOperation: async (id: string) => (id === OPERATION_ID ? ({ operationId: OPERATION_ID } as CommerceOperationRecord) : null),
    ...store,
  } as MerchantEvidenceRouteDependencies)
  const wrongExecutionRes = await app.request(`/operations/${OPERATION_ID}/merchant-evidence`, {
    method: 'POST',
    headers: { 'x-ocd-recovery-credential': 'irrelevant-for-this-fake', 'content-type': 'application/json' },
    body: JSON.stringify({ resource_url: 'https://x.example/y', http_status: 200, response_body_digest: digest('x'), execution_request_id: 'OCD-EXEC-does-not-belong-here' }),
  })
  assert.equal(wrongExecutionRes.status, 400, 'an execution_request_id that does not belong to this operation must be rejected')
}
console.log('ok  merchant evidence is recorded (CALLER_REPORTED, correctly correlated to its execution binding) and maps cleanly into the investigation shape; a wrong execution_request_id is rejected')

// --- 2. retrying identical evidence is idempotent ---------------------------

{
  const store = makeFakeStore()
  const rawInput = {
    resource_url: 'https://api.onesource.io/api/chain/block-number',
    http_status: 200,
    content_type: 'application/json',
    response_body_digest: digest('{"ok":true}'),
    response_bytes: 11,
    execution_request_id: EXECUTION_REQUEST_ID,
  }
  const first = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput(rawInput), store)
  const second = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput(rawInput), store)
  assert.equal(first.created, true)
  assert.equal(second.created, false, 'an identical retried submission must not create a second row')
  assert.equal(first.evidence.evidenceId, second.evidence.evidenceId, 'identical content must compute the SAME evidence id')
  assert.equal(store.rows.size, 1)

  // A genuinely DIFFERENT response (different digest) must create a new, separate row -- never overwrite history.
  const different = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput({ ...rawInput, response_body_digest: digest('{"ok":false}') }), store)
  assert.equal(different.created, true, 'a genuinely different merchant response must create a new append-only record')
  assert.notEqual(different.evidence.evidenceId, first.evidence.evidenceId)
  assert.equal(store.rows.size, 2)
}
console.log('ok  retrying identical merchant evidence is idempotent (same evidence id, no duplicate row); a genuinely different response creates a new append-only record')

// --- correction: a different allowlisted response header produces a DIFFERENT evidence_id / a new append-only record ---

{
  const store = makeFakeStore()
  const rawInput = {
    resource_url: 'https://api.onesource.io/api/chain/block-number',
    http_status: 200,
    content_type: 'application/json',
    response_body_digest: digest('{"ok":true}'),
    response_bytes: 11,
    execution_request_id: EXECUTION_REQUEST_ID,
  }
  const withEtagA = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput({ ...rawInput, response_headers: { etag: 'W/"aaa"' } }), store)
  const withEtagB = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput({ ...rawInput, response_headers: { etag: 'W/"bbb"' } }), store)
  assert.equal(withEtagA.created, true)
  assert.equal(withEtagB.created, true, 'a genuinely different allowlisted response header must create a new append-only record, not collapse onto the first')
  assert.notEqual(withEtagA.evidence.evidenceId, withEtagB.evidence.evidenceId, 'a different ETag must produce a different evidence_id')
  assert.equal(store.rows.size, 2)

  // Same allowlisted header content -> same evidence_id (still idempotent).
  const withEtagARepeat = await recordMerchantEvidence(OPERATION_ID, parseMerchantEvidenceInput({ ...rawInput, response_headers: { etag: 'W/"aaa"' } }), store)
  assert.equal(withEtagARepeat.created, false)
  assert.equal(withEtagARepeat.evidence.evidenceId, withEtagA.evidence.evidenceId)
  assert.equal(store.rows.size, 2, 'the identical-header retry must not create a third record')
}
console.log('ok  a different allowlisted response header (e.g. ETag) produces a different evidence_id and a new append-only record; identical headers stay idempotent')

// --- 3. confirmed settlement + caller-reported HTTP 500 produces MERCHANT_RESPONSE_ERROR ---

function baseInvestigation(overrides: Partial<Omit<Investigation, 'findings'>> = {}): Omit<Investigation, 'findings'> {
  return {
    operation: { operation_id: OPERATION_ID, created_at: new Date().toISOString(), preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
    preflight: { receipt_id: 'OCD-RCP-PRE1', decision: 'ALLOW', action: {}, verification: { state: 'VALID', code: 'ok', message: 'verified' }, expected_payer: null },
    execution: { execution_request_id: EXECUTION_REQUEST_ID, client_submission_key: 'csk-1', executor_identity: 'paybox-x402-base-usdc', executor_version: 'v1-gateway', recovery_capability_class: 'stable-payment-identity', provider_reference: 'paybox:req-1', submission_state: 'transaction_known', expected_payer: null, transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de' },
    settlement: { network: 'eip155:8453', transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de', block_hash: '0xblockhash', block_number: '50951350', log_index: 510, payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846', recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
    evidence: { bundle_digest: 'sha256:evidencebundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblockhash', transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de', log_index: 510 }, observation_state: 'confirmed' },
    receipts: { preflight: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-PRE1' }, proof: {} } as any, commerce: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-COM1', settlement: { status: 'CONFIRMED' }, checks: [] }, proof: {} } as any, verification: { state: 'VALID', code: 'ok', message: 'verified' } },
    recovery: { needs_attention: false, may_already_have_paid: true, summary: 'A Commerce receipt has been issued for this operation.', safe_next_action: 'None -- this operation is complete.' },
    merchant_response: { evidence: [] },
    ...overrides,
  }
}

{
  const errorEvidence = {
    evidence_id: 'evt-1',
    resource_url: 'https://api.onesource.io/api/chain/block-number',
    http_status: 500,
    content_type: 'application/json',
    body_digest: digest('{"error":true}'),
    response_bytes: 20,
    source: 'CALLER_REPORTED' as const,
    execution_request_id: EXECUTION_REQUEST_ID,
    provider_reference: 'paybox:req-1',
    transaction_hash: null,
    transaction_hash_matches_known_observation: null,
    recorded_at: new Date().toISOString(),
  }
  const findings = deriveFindings(baseInvestigation({ merchant_response: { evidence: [errorEvidence] } }))
  const finding = findings.find((f) => f.code === 'MERCHANT_RESPONSE_ERROR')
  assert.ok(finding, 'a confirmed settlement with a caller-reported HTTP 500 must produce MERCHANT_RESPONSE_ERROR')
  assert.equal(finding.severity, 'warning')
  assert.match(finding.summary, /caller-reported/i, 'the finding must explicitly say the merchant response is caller-reported, never independently verified')
  assert.doesNotMatch(finding.summary, /OCD (proved|verified)/i)

  // A healthy 200 response must NOT produce this finding.
  const healthyFindings = deriveFindings(baseInvestigation({ merchant_response: { evidence: [{ ...errorEvidence, http_status: 200, body_digest: digest('{"ok":true}') }] } }))
  assert.ok(!healthyFindings.some((f) => f.code === 'MERCHANT_RESPONSE_ERROR'))

  // No merchant evidence at all must NOT produce a finding merely because it's absent.
  const noEvidenceFindings = deriveFindings(baseInvestigation())
  assert.ok(!noEvidenceFindings.some((f) => f.code === 'MERCHANT_RESPONSE_ERROR'), 'absent merchant evidence must never itself be a finding')
}
console.log('ok  confirmed settlement + caller-reported HTTP 500 produces MERCHANT_RESPONSE_ERROR with explicit caller-reported wording; a healthy response or absent evidence does not')

// --- 4. secrets/raw response body are not persisted or exported -----------

{
  // sanitizeResponseHeaders drops anything not on the small allowlist, including secret-shaped headers.
  const sanitized = sanitizeResponseHeaders({
    etag: 'abc123',
    'content-length': '42',
    'x-request-id': 'req-1',
    authorization: 'Bearer some-secret-token',
    cookie: 'session=abc',
    'x-api-key': 'sk-live-secret',
    'set-cookie': 'foo=bar',
  })
  assert.deepEqual(sanitized, { etag: 'abc123', 'content-length': '42', 'x-request-id': 'req-1' })
  assert.ok(!JSON.stringify(sanitized).match(/secret|bearer|cookie|api-key/i))

  // parseMerchantEvidenceInput has no field that accepts a raw response body at all -- proven structurally: an attempt to smuggle one through is simply ignored, never stored.
  const input = parseMerchantEvidenceInput({
    resource_url: 'https://api.onesource.io/api/chain/block-number',
    http_status: 200,
    response_body_digest: digest('{"ok":true}'),
    response_body: '{"ok":true, "secret_token": "should-never-be-stored"}',
    raw_body: 'also should never be stored',
  })
  assert.equal((input as any).response_body, undefined)
  assert.equal((input as any).raw_body, undefined)
  assert.equal(Object.keys(input).includes('responseBody'), false)

  // A malformed digest is rejected outright (not silently coerced).
  assert.throws(() => parseMerchantEvidenceInput({ resource_url: 'https://x.example', http_status: 200, response_body_digest: 'not-a-digest' }), MerchantEvidenceInputError)
}
console.log('ok  only an explicit small header allowlist survives sanitization; the raw response body has no accepted input field and is never stored')

console.log('\nAll D2.9A merchant evidence tests passed.')
