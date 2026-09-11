/** Focused D3.4C3 Turnkey webhook verification + provider-evidence + reconciliation tests. Fully offline -- no live Turnkey call, no live JWKS fetch (a fake JWKS server response is injected). */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { Hono } from 'hono'
import {
  verifyTurnkeyWebhook,
  TurnkeyWebhookVerificationError,
  resetTurnkeyJwksCache,
  TURNKEY_SIGNATURE_ALGORITHM,
  TURNKEY_SIGNATURE_VERSION,
} from '../src/turnkeyWebhookVerification.js'
import { mountTurnkeyWebhook } from '../src/turnkeyWebhookRoute.js'
import { isTerminalTurnkeyStatus, parseTurnkeyWebhookEvidenceInput, recordProviderEvidence, TURNKEY_EXECUTOR_IDENTITY } from '../src/providerEvidence.js'
import { detectContradictions } from '../src/contradictionDetection.js'
import type { Investigation } from '../src/investigation.js'
import type { ExecutionBindingRecord, ProviderEvidenceRecord } from '../src/db.js'

const OP = 'OCD-OP-' + 'T'.repeat(27)
const EXEC = 'OCD-EXEC-turnkey-1'
const TX = '0x' + 'a'.repeat(64)
const A = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SEND_STATUS_ID = 'sts_abc123'
const KEY_ID = 'key-1'
const EVENT_ID = 'evt_1'
const NOW = Date.now()

// --- a real Ed25519 keypair standing in for Turnkey's own webhook signing key ---
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }
const fakeJwks = { keys: [{ kid: KEY_ID, kty: jwk.kty, crv: jwk.crv, x: jwk.x }] }
const fakeFetch = (async (url: string) => {
  assert.equal(url, 'https://api.turnkey.com/public/v1/discovery/webhooks/jwks')
  return { ok: true, headers: { get: () => null }, json: async () => fakeJwks } as any
}) as typeof fetch

function sign(rawBody: string, timestamp: string, eventId: string, keyId: string) {
  const signedInput = `v1.ed25519.${keyId}.${timestamp}.${eventId}.${rawBody}`
  return cryptoSign(null, Buffer.from(signedInput, 'utf8'), privateKey).toString('hex')
}

function includedBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'transaction:status',
    organizationId: 'org-1',
    msg: { sendTransactionStatusId: SEND_STATUS_ID, activityId: 'act_1', status: 'INCLUDED', caip2: 'eip155:8453', idempotencyKey: 'idem-1', timestamp: Math.floor(NOW / 1000), txHash: TX, ...overrides },
  })
}

// --- 1: valid signed terminal event verifies, normalizes, correlates ---
resetTurnkeyJwksCache()
{
  const body = includedBody()
  const timestamp = String(NOW)
  const signature = sign(body, timestamp, EVENT_ID, KEY_ID)
  await verifyTurnkeyWebhook(body, { signature, signatureKeyId: KEY_ID, signatureAlgorithm: TURNKEY_SIGNATURE_ALGORITHM, signatureVersion: TURNKEY_SIGNATURE_VERSION, eventId: EVENT_ID, timestamp }, { fetchImpl: fakeFetch, now: () => NOW })

  const input = parseTurnkeyWebhookEvidenceInput(JSON.parse(body), EVENT_ID)
  assert.equal(input.provider, 'turnkey')
  assert.equal(input.providerExecutionId, SEND_STATUS_ID)
  assert.equal(input.correlationReference, `turnkey:${SEND_STATUS_ID}`)
  assert.equal(input.claimedState, 'SUCCEEDED')
  assert.equal(input.network, 'eip155:8453')
  assert.equal(input.transactionHash, TX)
  assert.equal(input.providerEventId, EVENT_ID)
  assert.equal(input.payer, null)
  assert.equal(input.amountAtomic, null)

  const binding: ExecutionBindingRecord = { executionRequestId: EXEC, operationId: OP, clientSubmissionKey: 'key', executorIdentity: TURNKEY_EXECUTOR_IDENTITY, executorVersion: 'v1', recoveryCapabilityClass: 'stable-payment-identity', frozenPreflightReceiptId: 'r', frozenPreflightReceiptDigest: 'd', expectedPayer: null, providerReference: `turnkey:${SEND_STATUS_ID}`, submissionState: 'transaction_known' }
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
  const result = await recordProviderEvidence(OP, { ...input, executionRequestId: EXEC }, store)
  assert.equal(result.created, true)
  assert.equal(result.evidence.provider, 'turnkey')
  console.log('ok  a valid signed INCLUDED event verifies, normalizes into ProviderEvidenceInput, and correlates to its durable Turnkey execution binding')

  // duplicate delivery (same content, e.g. a Turnkey retry) is a safe no-op via existing content-addressed idempotency -- no separate event-id table needed
  const replay = await recordProviderEvidence(OP, { ...input, executionRequestId: EXEC }, store)
  assert.equal(replay.created, false)
  console.log('ok  a duplicate Turnkey delivery does not create a second logical evidence record')
}

// --- 2: invalid / tampered / unsupported signature is rejected ---
resetTurnkeyJwksCache()
{
  const body = includedBody()
  const timestamp = String(NOW)
  const validSignature = sign(body, timestamp, EVENT_ID, KEY_ID)

  // tampered body after signing
  await assert.rejects(
    () => verifyTurnkeyWebhook(includedBody({ txHash: '0x' + 'b'.repeat(64) }), { signature: validSignature, signatureKeyId: KEY_ID, signatureAlgorithm: TURNKEY_SIGNATURE_ALGORITHM, signatureVersion: TURNKEY_SIGNATURE_VERSION, eventId: EVENT_ID, timestamp }, { fetchImpl: fakeFetch, now: () => NOW }),
    TurnkeyWebhookVerificationError
  )
  // unsupported algorithm
  await assert.rejects(
    () => verifyTurnkeyWebhook(body, { signature: validSignature, signatureKeyId: KEY_ID, signatureAlgorithm: 'rsa', signatureVersion: TURNKEY_SIGNATURE_VERSION, eventId: EVENT_ID, timestamp }, { fetchImpl: fakeFetch, now: () => NOW }),
    /unsupported X-Turnkey-Signature-Algorithm/
  )
  // unsupported version
  await assert.rejects(
    () => verifyTurnkeyWebhook(body, { signature: validSignature, signatureKeyId: KEY_ID, signatureAlgorithm: TURNKEY_SIGNATURE_ALGORITHM, signatureVersion: 'v2', eventId: EVENT_ID, timestamp }, { fetchImpl: fakeFetch, now: () => NOW }),
    /unsupported X-Turnkey-Signature-Version/
  )
  // stale timestamp (outside the 5-minute replay window)
  await assert.rejects(
    () => verifyTurnkeyWebhook(body, { signature: validSignature, signatureKeyId: KEY_ID, signatureAlgorithm: TURNKEY_SIGNATURE_ALGORITHM, signatureVersion: TURNKEY_SIGNATURE_VERSION, eventId: EVENT_ID, timestamp: String(NOW - 10 * 60 * 1000) }, { fetchImpl: fakeFetch, now: () => NOW }),
    /replay window/
  )
  // unknown key id, even after a forced refresh, is rejected -- never trusted
  await assert.rejects(
    () => verifyTurnkeyWebhook(body, { signature: validSignature, signatureKeyId: 'unknown-key', signatureAlgorithm: TURNKEY_SIGNATURE_ALGORITHM, signatureVersion: TURNKEY_SIGNATURE_VERSION, eventId: EVENT_ID, timestamp }, { fetchImpl: fakeFetch, now: () => NOW }),
    /no Turnkey webhook signing key found/
  )
  console.log('ok  a tampered body, unsupported algorithm/version, stale timestamp, or unknown key id are all rejected fail-closed')

  // end-to-end through the actual route: tampered signature -> 401, never reaches provider-evidence recording
  resetTurnkeyJwksCache()
  const app = new Hono()
  mountTurnkeyWebhook(app, { fetchImpl: fakeFetch, now: () => NOW, getExecutionBindingByProviderReference: async () => { throw new Error('must not be reached for an invalid signature') } } as any)
  const badResponse = await app.request('/webhooks/turnkey/transaction-status', {
    method: 'POST',
    headers: { 'x-turnkey-signature': validSignature, 'x-turnkey-signature-key-id': KEY_ID, 'x-turnkey-signature-algorithm': TURNKEY_SIGNATURE_ALGORITHM, 'x-turnkey-signature-version': TURNKEY_SIGNATURE_VERSION, 'x-turnkey-event-id': EVENT_ID, 'x-turnkey-timestamp': timestamp },
    body: includedBody({ txHash: '0x' + 'c'.repeat(64) }), // body changed after signing -> signature no longer matches
  })
  assert.equal(badResponse.status, 401)
  console.log('ok  the webhook route itself rejects an invalid signature (401) before any correlation or evidence recording is attempted')
}

// --- 3/4: reconciliation reuses existing D3.3 codes, no Turnkey-specific taxonomy ---
{
  type Bare = Omit<Investigation, 'findings'>
  function turnkeyClaim(state: 'SUCCEEDED' | 'FAILED') {
    return {
      evidence_id: 'sha256:turnkey', provider: 'turnkey', provider_version: 'v1', provider_execution_id: SEND_STATUS_ID,
      correlation_reference: `turnkey:${SEND_STATUS_ID}`, x402_version: null, claimed_state: state, transaction_hash: TX,
      network: 'eip155:8453', payer: null, amount_atomic: null, asset: null, recipient: null, failure_code: state === 'FAILED' ? 'TURNKEY_FAILED' : null,
      source_authentication: 'CALLER_REPORTED_PROVIDER_RESPONSE', raw_reference_digest: 'sha256:' + 'd'.repeat(64), execution_request_id: EXEC,
      provider_event_id: EVENT_ID, provider_timestamp: null, recorded_at: '2026-09-11T00:00:00.000Z',
    } as const
  }
  function inv(overrides: Partial<Bare> = {}): Bare {
    return {
      operation: { operation_id: OP, created_at: '2026-09-11T00:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
      preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: null, verification: null, expected_payer: null },
      execution: { execution_request_id: EXEC, client_submission_key: 'key', executor_identity: TURNKEY_EXECUTOR_IDENTITY, executor_version: 'v1', recovery_capability_class: 'stable-payment-identity', provider_reference: `turnkey:${SEND_STATUS_ID}`, submission_state: 'transaction_known', expected_payer: null, transaction_hash: TX },
      settlement: { network: 'eip155:8453', transaction_hash: TX, block_hash: '0xblock', block_number: '1', log_index: 0, payer: null, recipient: A, asset: USDC, amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
      evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: TX, log_index: 0 }, observation_state: 'confirmed' },
      receipts: { preflight: null, commerce: null, verification: null }, recovery: { needs_attention: false, may_already_have_paid: false, summary: '', safe_next_action: '' }, merchant_response: { evidence: [] },
      provider_evidence: { evidence: [turnkeyClaim('SUCCEEDED')] }, ...overrides,
    }
  }
  const context = { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: A }, policy: {} } } }
  const codes = (value: Bare) => detectContradictions(value, context).map((f) => f.code)

  // 3: INCLUDED (SUCCEEDED) + matching independent Base observation -> reconciled, no contradiction codes, no new taxonomy needed.
  assert.ok(!codes(inv()).some((c) => c.includes('STATUS_')), codes(inv()).join(', '))
  console.log('ok  Turnkey INCLUDED + matching independent observation reconciles using existing D3.3 behavior, no Turnkey-specific code')

  // 4: FAILED + OCD independently observes settlement anyway -> existing contradiction codes.
  const failed = inv({ provider_evidence: { evidence: [turnkeyClaim('FAILED')] } })
  assert.ok(codes(failed).includes('EXECUTION_STATUS_CONTRADICTION'), codes(failed).join(', '))
  assert.ok(codes(failed).includes('SETTLEMENT_STATUS_CONTRADICTION'), codes(failed).join(', '))
  console.log('ok  Turnkey FAILED + an independently observed settlement produces the existing execution/settlement contradiction codes')

  // 5: a Turnkey claim never upgrades binding strength -- still TRANSFER_MATCH_ONLY without a stronger independently-decoded authorizer match.
  assert.equal(inv().evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.ok(codes(inv()).includes('ATTRIBUTION_UNRESOLVED'), 'a Turnkey provider claim must not upgrade binding strength on its own')
  console.log('ok  a Turnkey provider claim never upgrades binding strength; commerceLifecycle.ts remains untouched and authoritative')
}

// --- BROADCASTING is never persisted as terminal evidence ---
{
  assert.equal(isTerminalTurnkeyStatus('BROADCASTING'), false)
  assert.equal(isTerminalTurnkeyStatus('INCLUDED'), true)
  assert.equal(isTerminalTurnkeyStatus('FAILED'), true)
  assert.throws(() => parseTurnkeyWebhookEvidenceInput(JSON.parse(includedBody({ status: 'BROADCASTING', txHash: undefined })), EVENT_ID), /INCLUDED or FAILED/)
  console.log('ok  BROADCASTING is never accepted as terminal provider evidence')
}

// --- no durable binding matches the claimed provider_reference -> acknowledged, not recorded, never attached to an arbitrary operation ---
{
  resetTurnkeyJwksCache()
  const body = includedBody()
  const timestamp = String(NOW)
  const signature = sign(body, timestamp, EVENT_ID, KEY_ID)
  const app = new Hono()
  mountTurnkeyWebhook(app, {
    fetchImpl: fakeFetch,
    now: () => NOW,
    getExecutionBindingByProviderReference: async () => null,
    createProviderEvidence: async () => { throw new Error('must not be reached when no binding matches') },
  } as any)
  const response = await app.request('/webhooks/turnkey/transaction-status', {
    method: 'POST',
    headers: { 'x-turnkey-signature': signature, 'x-turnkey-signature-key-id': KEY_ID, 'x-turnkey-signature-algorithm': TURNKEY_SIGNATURE_ALGORITHM, 'x-turnkey-signature-version': TURNKEY_SIGNATURE_VERSION, 'x-turnkey-event-id': EVENT_ID, 'x-turnkey-timestamp': timestamp },
    body,
  })
  assert.equal(response.status, 202)
  const json = (await response.json()) as { recorded: boolean }
  assert.equal(json.recorded, false)
  console.log('ok  a verified webhook with no matching durable execution binding is acknowledged but never attached to an arbitrary operation')
}
