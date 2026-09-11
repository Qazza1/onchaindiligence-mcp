/** Focused D3.4C6 Circle webhook verification + provider-evidence + reconciliation tests. Fully offline -- no live Circle account, no live authenticated public-key fetch (a fake fetchPublicKey dependency is injected). */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { Hono } from 'hono'
import {
  verifyCircleWebhook,
  CircleWebhookVerificationError,
  resetCircleKeyCache,
  CIRCLE_SIGNATURE_ALGORITHM,
} from '../src/circleWebhookVerification.js'
import { mountCircleWebhook } from '../src/circleWebhookRoute.js'
import { isTerminalCircleState, isCircleOutboundNotification, parseCircleWebhookEvidenceInput, recordProviderEvidence, CIRCLE_EXECUTOR_IDENTITY } from '../src/providerEvidence.js'
import { detectContradictions } from '../src/contradictionDetection.js'
import type { Investigation } from '../src/investigation.js'
import type { ExecutionBindingRecord, ProviderEvidenceRecord } from '../src/db.js'

const OP = 'OCD-OP-' + 'E'.repeat(27)
const EXEC = 'OCD-EXEC-circle-1'
const TX = '0x' + 'a'.repeat(64)
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TXN_ID = 'circle-txn-abc123'
const KEY_ID = 'key-1'

// --- a real EC P-256 keypair standing in for Circle's own notification signing key ---
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
const fakeFetchPublicKey = async (keyId: string) => {
  assert.equal(keyId, KEY_ID)
  return { publicKeyDer: publicKeyDer as Buffer, algorithm: CIRCLE_SIGNATURE_ALGORITHM }
}

function sign(rawBody: string) {
  return cryptoSign('sha256', Buffer.from(rawBody, 'utf8'), privateKey).toString('base64')
}

function outboundBody(overrides: Record<string, unknown> = {}, notificationOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    subscriptionId: 'sub-1',
    notificationId: 'notif-1',
    notificationType: 'transactions.outbound',
    notification: { id: TXN_ID, state: 'COMPLETE', blockchain: 'BASE', txHash: TX, sourceAddress: A, destinationAddress: B, ...notificationOverrides },
    timestamp: '2026-09-11T00:00:00.000Z',
    version: 2,
    ...overrides,
  })
}

// --- 1: valid signed terminal event verifies, normalizes, correlates ---
resetCircleKeyCache()
{
  const body = outboundBody()
  const signature = sign(body)
  await verifyCircleWebhook(body, { signature, keyId: KEY_ID }, { fetchPublicKey: fakeFetchPublicKey })

  const parsedBody = JSON.parse(body)
  assert.equal(isCircleOutboundNotification(parsedBody.notificationType), true)
  const input = parseCircleWebhookEvidenceInput(parsedBody)
  assert.equal(input.provider, 'circle')
  assert.equal(input.providerExecutionId, TXN_ID)
  assert.equal(input.correlationReference, `circle:${TXN_ID}`)
  assert.equal(input.claimedState, 'SUCCEEDED')
  assert.equal(input.network, 'eip155:8453')
  assert.equal(input.transactionHash, TX)
  assert.equal(input.providerEventId, 'notif-1')
  assert.equal(input.payer, A)
  assert.equal(input.recipient, B)
  // Deliberately null this milestone -- see providerEvidence.ts's Circle section header.
  assert.equal(input.amountAtomic, null)
  assert.equal(input.asset, null)

  const binding: ExecutionBindingRecord = { executionRequestId: EXEC, operationId: OP, clientSubmissionKey: 'key', executorIdentity: CIRCLE_EXECUTOR_IDENTITY, executorVersion: 'v2', recoveryCapabilityClass: 'stable-payment-identity', frozenPreflightReceiptId: 'r', frozenPreflightReceiptDigest: 'd', expectedPayer: null, providerReference: `circle:${TXN_ID}`, submissionState: 'transaction_known' }
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
  assert.equal(result.evidence.provider, 'circle')
  console.log('ok  a valid signed transactions.outbound COMPLETE event verifies, normalizes into ProviderEvidenceInput, and correlates to its durable Circle execution binding')

  const replay = await recordProviderEvidence(OP, { ...input, executionRequestId: EXEC }, store)
  assert.equal(replay.created, false)
  console.log('ok  a duplicate Circle delivery does not create a second logical evidence record')
}

// --- 2: terminal FAILED normalizes correctly; non-terminal states are rejected/acknowledged ---
{
  const failedBody = JSON.parse(outboundBody({}, { state: 'FAILED', txHash: undefined }))
  const input = parseCircleWebhookEvidenceInput(failedBody)
  assert.equal(input.claimedState, 'FAILED')
  assert.equal(input.transactionHash, null)
  assert.equal(input.failureCode, 'FAILED')
  console.log('ok  a terminal Circle FAILED event normalizes correctly with no transaction hash')

  for (const state of ['INITIATED', 'QUEUED', 'SENT', 'CONFIRMED']) {
    assert.equal(isTerminalCircleState(state), false, `${state} must not be terminal`)
  }
  for (const state of ['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']) {
    assert.equal(isTerminalCircleState(state), true, `${state} must be terminal`)
  }
  assert.throws(() => parseCircleWebhookEvidenceInput(JSON.parse(outboundBody({}, { state: 'CONFIRMED', txHash: undefined }))), /non-terminal/)
  console.log('ok  CONFIRMED (included, awaiting finality per Circle\'s own docs) is never accepted as terminal provider evidence, matching COMPLETE\'s stronger finality guarantee')
}

// --- 3: invalid / tampered signature is rejected ---
resetCircleKeyCache()
{
  const body = outboundBody()
  const validSignature = sign(body)

  await assert.rejects(
    () => verifyCircleWebhook(outboundBody({}, { txHash: '0x' + 'b'.repeat(64) }), { signature: validSignature, keyId: KEY_ID }, { fetchPublicKey: fakeFetchPublicKey }),
    CircleWebhookVerificationError
  )
  await assert.rejects(
    () => verifyCircleWebhook(body, { signature: null, keyId: KEY_ID }, { fetchPublicKey: fakeFetchPublicKey }),
    /missing one or more required/
  )
  await assert.rejects(
    () => verifyCircleWebhook(body, { signature: validSignature, keyId: 'key-with-wrong-algorithm' }, { fetchPublicKey: async () => ({ publicKeyDer: publicKeyDer as Buffer, algorithm: 'RSA_SHA_256' }) }),
    /unsupported Circle notification signature algorithm/
  )
  console.log('ok  a tampered body, missing headers, or an unexpected signature algorithm are all rejected fail-closed')

  resetCircleKeyCache()
  const app = new Hono()
  mountCircleWebhook(app, { fetchPublicKey: fakeFetchPublicKey, getExecutionBindingByProviderReference: async () => { throw new Error('must not be reached for an invalid signature') } } as any)
  const badResponse = await app.request('/webhooks/circle/transaction-status', {
    method: 'POST',
    headers: { 'x-circle-signature': validSignature, 'x-circle-key-id': KEY_ID },
    body: outboundBody({}, { txHash: '0x' + 'c'.repeat(64) }), // body changed after signing -> signature no longer matches
  })
  assert.equal(badResponse.status, 401)
  console.log('ok  the webhook route itself rejects an invalid signature (401) before any correlation or evidence recording is attempted')
}

// --- 4/5: reconciliation reuses existing D3.3 codes, no Circle-specific taxonomy ---
{
  type Bare = Omit<Investigation, 'findings'>
  function circleClaim(state: 'SUCCEEDED' | 'FAILED') {
    return {
      evidence_id: 'sha256:circle', provider: 'circle', provider_version: 'v2', provider_execution_id: TXN_ID,
      correlation_reference: `circle:${TXN_ID}`, x402_version: null, claimed_state: state, transaction_hash: state === 'SUCCEEDED' ? TX : null,
      network: 'eip155:8453', payer: A, amount_atomic: null, asset: null, recipient: B, failure_code: state === 'FAILED' ? 'FAILED' : null,
      source_authentication: 'CALLER_REPORTED_PROVIDER_RESPONSE', raw_reference_digest: 'sha256:' + 'd'.repeat(64), execution_request_id: EXEC,
      provider_event_id: 'notif-1', provider_timestamp: '2026-09-11T00:00:00.000Z', recorded_at: '2026-09-11T00:00:00.000Z',
    } as const
  }
  function inv(overrides: Partial<Bare> = {}): Bare {
    return {
      operation: { operation_id: OP, created_at: '2026-09-11T00:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
      preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: null, verification: null, expected_payer: null },
      execution: { execution_request_id: EXEC, client_submission_key: 'key', executor_identity: CIRCLE_EXECUTOR_IDENTITY, executor_version: 'v2', recovery_capability_class: 'stable-payment-identity', provider_reference: `circle:${TXN_ID}`, submission_state: 'transaction_known', expected_payer: null, transaction_hash: TX },
      settlement: { network: 'eip155:8453', transaction_hash: TX, block_hash: '0xblock', block_number: '1', log_index: 0, payer: A, recipient: B, asset: USDC, amount_atomic: '1000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
      evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: TX, log_index: 0 }, observation_state: 'confirmed' },
      receipts: { preflight: null, commerce: null, verification: null }, recovery: { needs_attention: false, may_already_have_paid: false, summary: '', safe_next_action: '' }, merchant_response: { evidence: [] },
      provider_evidence: { evidence: [circleClaim('SUCCEEDED')] }, ...overrides,
    }
  }
  const context = { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '0.001', recipient: B }, policy: {} } } }
  const codes = (value: Bare) => detectContradictions(value, context).map((f) => f.code)

  assert.ok(!codes(inv()).some((c) => c.includes('STATUS_')), codes(inv()).join(', '))
  console.log('ok  Circle COMPLETE + matching independent observation reconciles using existing D3.3 behavior, no Circle-specific code')

  const failed = inv({ provider_evidence: { evidence: [circleClaim('FAILED')] } })
  assert.ok(codes(failed).includes('EXECUTION_STATUS_CONTRADICTION'), codes(failed).join(', '))
  assert.ok(codes(failed).includes('SETTLEMENT_STATUS_CONTRADICTION'), codes(failed).join(', '))
  console.log('ok  Circle FAILED + an independently observed settlement produces the existing execution/settlement contradiction codes')

  assert.equal(inv().evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.ok(codes(inv()).includes('ATTRIBUTION_UNRESOLVED'), 'a Circle provider claim must not upgrade binding strength on its own')
  console.log('ok  a Circle provider claim never upgrades binding strength; commerceLifecycle.ts remains untouched and authoritative')
}

// --- 6: no durable binding matches the claimed provider_reference -> acknowledged, not recorded, never attached to an arbitrary operation ---
{
  resetCircleKeyCache()
  const body = outboundBody()
  const signature = sign(body)
  const app = new Hono()
  mountCircleWebhook(app, {
    fetchPublicKey: fakeFetchPublicKey,
    getExecutionBindingByProviderReference: async () => null,
    createProviderEvidence: async () => { throw new Error('must not be reached when no binding matches') },
  } as any)
  const response = await app.request('/webhooks/circle/transaction-status', {
    method: 'POST',
    headers: { 'x-circle-signature': signature, 'x-circle-key-id': KEY_ID },
    body,
  })
  assert.equal(response.status, 202)
  const json = (await response.json()) as { recorded: boolean }
  assert.equal(json.recorded, false)
  console.log('ok  a verified webhook with no matching durable execution binding is acknowledged but never attached to an arbitrary operation')

  // a validly-signed but out-of-scope notification type (transactions.inbound) is acknowledged, never recorded
  const inboundBody = JSON.stringify({ subscriptionId: 'sub-1', notificationId: 'notif-2', notificationType: 'transactions.inbound', notification: { id: 'circle-in-1', state: 'COMPLETE', blockchain: 'BASE', txHash: TX }, timestamp: '2026-09-11T00:00:00.000Z', version: 2 })
  const inSignature = sign(inboundBody)
  const app2 = new Hono()
  mountCircleWebhook(app2, { fetchPublicKey: fakeFetchPublicKey, getExecutionBindingByProviderReference: async () => { throw new Error('must not be reached for an out-of-scope notification type') } } as any)
  const inResponse = await app2.request('/webhooks/circle/transaction-status', { method: 'POST', headers: { 'x-circle-signature': inSignature, 'x-circle-key-id': KEY_ID }, body: inboundBody })
  assert.equal(inResponse.status, 202)
  console.log('ok  a validly-signed transactions.inbound event is acknowledged but never treated as OCD execution evidence')
}
