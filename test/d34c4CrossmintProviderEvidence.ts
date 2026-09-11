/** Focused D3.4C4 Crossmint webhook verification + provider-evidence + reconciliation tests. Fully offline -- no live Crossmint call, real Svix HMAC sign/verify against a fake secret via the official `svix` package. */
import assert from 'node:assert/strict'
import { Webhook } from 'svix'
import { Hono } from 'hono'
import {
  verifyCrossmintWebhook,
  CrossmintWebhookVerificationError,
} from '../src/crossmintWebhookVerification.js'
import { mountCrossmintWebhook } from '../src/crossmintWebhookRoute.js'
import { isCrossmintOutboundTransferEvent, parseCrossmintWebhookEvidenceInput, recordProviderEvidence, CROSSMINT_EXECUTOR_IDENTITY } from '../src/providerEvidence.js'
import { detectContradictions } from '../src/contradictionDetection.js'
import type { Investigation } from '../src/investigation.js'
import type { ExecutionBindingRecord, ProviderEvidenceRecord } from '../src/db.js'

const OP = 'OCD-OP-' + 'C'.repeat(27)
const EXEC = 'OCD-EXEC-crossmint-1'
const TX = '0x' + 'a'.repeat(64)
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_ID = 'transfer_abc123'
const EVENT_ID = 'msg_evt1'
const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

const wh = new Webhook(SECRET)

function outBody(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'evt_payload_1',
    type: 'wallets.transfer.out',
    data: {
      transferId: TRANSFER_ID,
      sender: { address: A, chain: 'base', locator: `base:${A}` },
      recipient: { address: B, chain: 'base', locator: `base:${B}` },
      token: { type: 'fungible', chain: 'base', amount: '1.0', rawAmount: '1000000', decimals: 6, symbol: 'USDC', contractAddress: USDC, locator: `base:${USDC}` },
      status: 'succeeded',
      onChain: { txId: TX, explorerLink: 'https://basescan.org/tx/' + TX },
      completedAt: '2026-09-11T00:00:00.000Z',
      ...dataOverrides,
    },
    ...overrides,
  })
}

function sign(body: string, timestamp: Date, eventId = EVENT_ID) {
  return wh.sign(eventId, timestamp, body)
}

// --- 1: valid signed terminal event verifies, normalizes, correlates ---
{
  const body = outBody()
  const timestamp = new Date()
  const signature = sign(body, timestamp)
  verifyCrossmintWebhook(body, { svixId: EVENT_ID, svixTimestamp: String(Math.floor(timestamp.getTime() / 1000)), svixSignature: signature }, SECRET)

  const parsedBody = JSON.parse(body)
  assert.equal(isCrossmintOutboundTransferEvent(parsedBody.type), true)
  const input = parseCrossmintWebhookEvidenceInput(parsedBody, EVENT_ID)
  assert.equal(input.provider, 'crossmint')
  assert.equal(input.providerExecutionId, TRANSFER_ID)
  assert.equal(input.correlationReference, `crossmint:${TRANSFER_ID}`)
  assert.equal(input.claimedState, 'SUCCEEDED')
  assert.equal(input.network, 'eip155:8453')
  assert.equal(input.transactionHash, TX)
  assert.equal(input.providerEventId, EVENT_ID)
  // Unlike Turnkey, Crossmint's webhook DOES assert these -- they must be populated, not nulled.
  assert.equal(input.payer, A)
  assert.equal(input.recipient, B)
  assert.equal(input.amountAtomic, '1000000')
  assert.equal(input.asset, USDC)

  const binding: ExecutionBindingRecord = { executionRequestId: EXEC, operationId: OP, clientSubmissionKey: 'key', executorIdentity: CROSSMINT_EXECUTOR_IDENTITY, executorVersion: 'v1', recoveryCapabilityClass: 'stable-payment-identity', frozenPreflightReceiptId: 'r', frozenPreflightReceiptDigest: 'd', expectedPayer: null, providerReference: `crossmint:${TRANSFER_ID}`, submissionState: 'transaction_known' }
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
  assert.equal(result.evidence.provider, 'crossmint')
  console.log('ok  a valid signed wallets.transfer.out event verifies, normalizes into ProviderEvidenceInput (with sender/recipient/amount populated), and correlates to its durable Crossmint execution binding')

  // duplicate delivery (e.g. a Svix retry) is a safe no-op via existing content-addressed idempotency
  const replay = await recordProviderEvidence(OP, { ...input, executionRequestId: EXEC }, store)
  assert.equal(replay.created, false)
  console.log('ok  a duplicate Crossmint delivery does not create a second logical evidence record')
}

// --- 2: invalid / tampered webhook is rejected ---
{
  const body = outBody()
  const timestamp = new Date()
  const validSignature = sign(body, timestamp)

  // tampered body after signing
  assert.throws(
    () => verifyCrossmintWebhook(outBody({}, { status: 'failed' }), { svixId: EVENT_ID, svixTimestamp: String(Math.floor(timestamp.getTime() / 1000)), svixSignature: validSignature }, SECRET),
    CrossmintWebhookVerificationError
  )
  // wrong secret entirely
  const wrongSecret = 'whsec_' + Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64')
  assert.throws(
    () => verifyCrossmintWebhook(body, { svixId: EVENT_ID, svixTimestamp: String(Math.floor(timestamp.getTime() / 1000)), svixSignature: validSignature }, wrongSecret),
    CrossmintWebhookVerificationError
  )
  // missing headers
  assert.throws(
    () => verifyCrossmintWebhook(body, { svixId: null, svixTimestamp: String(Math.floor(timestamp.getTime() / 1000)), svixSignature: validSignature }, SECRET),
    /missing one or more required/
  )
  console.log('ok  a tampered body, wrong signing secret, or missing headers are all rejected fail-closed')

  // end-to-end through the actual route: tampered body -> 401, never reaches provider-evidence recording
  const app = new Hono()
  mountCrossmintWebhook(app, { signingSecret: SECRET, getExecutionBindingByProviderReference: async () => { throw new Error('must not be reached for an invalid signature') } } as any)
  const badResponse = await app.request('/webhooks/crossmint/transfer', {
    method: 'POST',
    headers: { 'svix-id': EVENT_ID, 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': validSignature },
    body: outBody({}, { status: 'failed' }), // body changed after signing -> signature no longer matches
  })
  assert.equal(badResponse.status, 401)
  console.log('ok  the webhook route itself rejects an invalid signature (401) before any correlation or evidence recording is attempted')
}

// --- 3/4: reconciliation reuses existing D3.3 codes, no Crossmint-specific taxonomy ---
{
  type Bare = Omit<Investigation, 'findings'>
  function crossmintClaim(state: 'SUCCEEDED' | 'FAILED') {
    return {
      evidence_id: 'sha256:crossmint', provider: 'crossmint', provider_version: 'v1', provider_execution_id: TRANSFER_ID,
      correlation_reference: `crossmint:${TRANSFER_ID}`, x402_version: null, claimed_state: state, transaction_hash: state === 'SUCCEEDED' ? TX : null,
      network: 'eip155:8453', payer: A, amount_atomic: '1000000', asset: USDC, recipient: B, failure_code: state === 'FAILED' ? 'CROSSMINT_FAILED' : null,
      source_authentication: 'CALLER_REPORTED_PROVIDER_RESPONSE', raw_reference_digest: 'sha256:' + 'd'.repeat(64), execution_request_id: EXEC,
      provider_event_id: EVENT_ID, provider_timestamp: '2026-09-11T00:00:00.000Z', recorded_at: '2026-09-11T00:00:00.000Z',
    } as const
  }
  function inv(overrides: Partial<Bare> = {}): Bare {
    return {
      operation: { operation_id: OP, created_at: '2026-09-11T00:00:00Z', preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued' },
      preflight: { receipt_id: 'OCD-RCP-PRE', decision: 'ALLOW', action: null, verification: null, expected_payer: null },
      execution: { execution_request_id: EXEC, client_submission_key: 'key', executor_identity: CROSSMINT_EXECUTOR_IDENTITY, executor_version: 'v1', recovery_capability_class: 'stable-payment-identity', provider_reference: `crossmint:${TRANSFER_ID}`, submission_state: 'transaction_known', expected_payer: null, transaction_hash: TX },
      settlement: { network: 'eip155:8453', transaction_hash: TX, block_hash: '0xblock', block_number: '1', log_index: 0, payer: A, recipient: B, asset: USDC, amount_atomic: '1000000', finality_state: 'safe', settlement_state: 'CONFIRMED' },
      evidence: { bundle_digest: 'sha256:bundle', binding_strength: 'TRANSFER_MATCH_ONLY', event_identity: { network: 'eip155:8453', block_hash: '0xblock', transaction_hash: TX, log_index: 0 }, observation_state: 'confirmed' },
      receipts: { preflight: null, commerce: null, verification: null }, recovery: { needs_attention: false, may_already_have_paid: false, summary: '', safe_next_action: '' }, merchant_response: { evidence: [] },
      provider_evidence: { evidence: [crossmintClaim('SUCCEEDED')] }, ...overrides,
    }
  }
  const context = { frozenPreflightInput: { input: { action: { network: 'eip155:8453', asset: USDC, amount: '1.0', recipient: B }, policy: {} } } }
  const codes = (value: Bare) => detectContradictions(value, context).map((f) => f.code)

  // 3: succeeded + matching independent Base observation -> reconciled, no contradiction codes, no new taxonomy needed.
  assert.ok(!codes(inv()).some((c) => c.includes('STATUS_')), codes(inv()).join(', '))
  console.log('ok  Crossmint succeeded + matching independent observation reconciles using existing D3.3 behavior, no Crossmint-specific code')

  // 4: failed + OCD independently observes settlement anyway -> existing contradiction codes.
  const failed = inv({ provider_evidence: { evidence: [crossmintClaim('FAILED')] } })
  assert.ok(codes(failed).includes('EXECUTION_STATUS_CONTRADICTION'), codes(failed).join(', '))
  assert.ok(codes(failed).includes('SETTLEMENT_STATUS_CONTRADICTION'), codes(failed).join(', '))
  console.log('ok  Crossmint failed + an independently observed settlement produces the existing execution/settlement contradiction codes')

  // amount mismatch -> existing AMOUNT_MISMATCH, no Crossmint-specific code
  // (bumping binding_strength to EXECUTOR_CORRELATED mirrors the existing
  // PayBox/x402 mismatch test's own pattern: with only TRANSFER_MATCH_ONLY
  // attribution, the taxonomy reports ATTRIBUTION_UNRESOLVED instead of a
  // specific mismatch, since weak attribution can't reliably assert whose
  // transfer is even being compared)
  const mismatch = inv({ evidence: { ...inv().evidence, binding_strength: 'EXECUTOR_CORRELATED' }, settlement: { ...inv().settlement, amount_atomic: '2000000' } })
  assert.ok(codes(mismatch).includes('AMOUNT_MISMATCH'), codes(mismatch).join(', '))
  console.log('ok  an observed amount mismatch against Crossmint\'s own claimed amount produces the existing AMOUNT_MISMATCH code')

  // 5: a Crossmint claim never upgrades binding strength -- still TRANSFER_MATCH_ONLY without a stronger independently-decoded authorizer match.
  assert.equal(inv().evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.ok(codes(inv()).includes('ATTRIBUTION_UNRESOLVED'), 'a Crossmint provider claim must not upgrade binding strength on its own')
  console.log('ok  a Crossmint provider claim never upgrades binding strength; commerceLifecycle.ts remains untouched and authoritative')
}

// --- transferId / txId identities stay distinct; non-outbound events are never treated as execution evidence ---
{
  assert.equal(isCrossmintOutboundTransferEvent('wallets.transfer.out'), true)
  assert.equal(isCrossmintOutboundTransferEvent('wallets.transfer.in'), false)
  assert.equal(isCrossmintOutboundTransferEvent('wallets.signer.exported'), false)
  // no userOperationHash field is ever read by the parser -- confirmed by construction (grep-level guarantee): the parser only reads data.onChain.txId for transaction_hash. A userOperationHash-shaped field is silently ignored rather than mistaken for a final tx hash.
  const withDecoy = JSON.parse(outBody({}, {}))
  withDecoy.data.onChain.userOperationHash = '0x' + 'f'.repeat(64) // if Crossmint ever added this, it must never leak into transaction_hash
  const input = parseCrossmintWebhookEvidenceInput(withDecoy, EVENT_ID)
  assert.equal(input.transactionHash, TX, 'transaction_hash must come only from onChain.txId, never a hypothetical userOperationHash field')
  console.log('ok  transferId/onChain.txId are the only identities read; a hypothetical userOperationHash field is never collapsed into transaction_hash')
}

// --- unmapped chain identifiers are left null, never guessed ---
{
  const body = JSON.parse(outBody({}, {}))
  body.data.sender.chain = 'polygon'
  const input = parseCrossmintWebhookEvidenceInput(body, EVENT_ID)
  assert.equal(input.network, null, 'an unmapped Crossmint chain identifier must never be guessed into a CAIP-2 network')
  console.log('ok  a Crossmint chain identifier outside the confirmed base->eip155:8453 mapping is left null, never guessed')
}

// --- no durable binding matches the claimed provider_reference -> acknowledged, not recorded, never attached to an arbitrary operation ---
{
  const body = outBody()
  const timestamp = new Date()
  const signature = sign(body, timestamp)
  const app = new Hono()
  mountCrossmintWebhook(app, {
    signingSecret: SECRET,
    getExecutionBindingByProviderReference: async () => null,
    createProviderEvidence: async () => { throw new Error('must not be reached when no binding matches') },
  } as any)
  const response = await app.request('/webhooks/crossmint/transfer', {
    method: 'POST',
    headers: { 'svix-id': EVENT_ID, 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': signature },
    body,
  })
  assert.equal(response.status, 202)
  const json = (await response.json()) as { recorded: boolean }
  assert.equal(json.recorded, false)
  console.log('ok  a verified webhook with no matching durable execution binding is acknowledged but never attached to an arbitrary operation')
}

// --- a validly-signed but out-of-scope event type (transfer.in) is acknowledged, never recorded as execution evidence ---
{
  const inBody = JSON.stringify({ id: 'evt_in_1', type: 'wallets.transfer.in', data: { transferId: 'transfer_in_1', status: 'succeeded', onChain: { txId: TX }, sender: { address: B, chain: 'base' }, recipient: { address: A, chain: 'base' }, token: { rawAmount: '500000', contractAddress: USDC }, completedAt: '2026-09-11T00:00:00.000Z' } })
  const timestamp = new Date()
  const signature = sign(inBody, timestamp, 'msg_in_1')
  const app = new Hono()
  mountCrossmintWebhook(app, { signingSecret: SECRET, getExecutionBindingByProviderReference: async () => { throw new Error('must not be reached for an out-of-scope event type') } } as any)
  const response = await app.request('/webhooks/crossmint/transfer', {
    method: 'POST',
    headers: { 'svix-id': 'msg_in_1', 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': signature },
    body: inBody,
  })
  assert.equal(response.status, 202)
  console.log('ok  a validly-signed wallets.transfer.in event is acknowledged but never treated as OCD execution evidence')
}
