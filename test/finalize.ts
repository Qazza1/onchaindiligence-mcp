/** D2.2 focused tests for the finalization orchestration (finalizePayment()).
 *
 * Run with: npx tsx test/finalize.ts
 *
 * Fully offline: every dependency (capability store, receipt store, chain
 * observation, signing, key registry, consume-and-publish) is injected as a
 * fake. No real Postgres write, no real RPC call, no real signing call.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import {
  finalizePayment,
  FinalizationAuthError,
  FinalizationConflictError,
  FinalizationInputError,
  FinalizationServiceError,
  FinalizationPendingError,
} from '../src/finalizeRoute.js'
import { finalizeReceiptCore, receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE, PUBLIC_ACTION_RECEIPT_SCHEMA } from '../src/receipts.js'
import { UnsupportedSettlementScopeError, type SettlementObservation } from '../src/settlement.js'
import type { CapabilityRecord } from '../src/db.js'
import type { Receipt, PublicActionReceiptEnvelope, ReceiptCoreFields } from '../src/receipts.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const SENDER = '0x2222222222222222222222222222222222222222'
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const OTHER_TX_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const KEY_ID = 'ed25519-TESTKEYFORFINALIZE'
const fakeRegistry = [
  { key_id: KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null },
]
async function fakeSignReceipt(receipt: Receipt): Promise<PublicActionReceiptEnvelope['proof']> {
  const issued_at = new Date().toISOString()
  const signingInput = receiptAttestationSigningInput(receipt, {
    issuer: PUBLIC_ACTION_RECEIPT_ISSUER,
    purpose: PUBLIC_ACTION_RECEIPT_PURPOSE,
    issuedAt: issued_at,
    keyId: KEY_ID,
  })
  const signature = ed25519Sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return { signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: PUBLIC_ACTION_RECEIPT_ISSUER, purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issued_at, key_id: KEY_ID, algorithm: 'ed25519', signature }
}

async function makePreflightEnvelope(): Promise<PublicActionReceiptEnvelope> {
  const core: ReceiptCoreFields = {
    receipt_type: 'PREFLIGHT',
    issued_at: '2026-09-04T00:00:00.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '1.00', sender: null, recipient: RECIPIENT },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'x' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  }
  const receipt = finalizeReceiptCore(core)
  const proof = await fakeSignReceipt(receipt) // a genuinely valid signature, not a stub
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }
}

const SUCCESS_OBSERVATION: SettlementObservation = {
  state: 'success',
  blockNumber: 100n,
  blockTimestamp: '2026-09-04T00:01:00.000Z',
  confirmations: 5,
  sufficientlyConfirmed: true,
  transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
  rpcError: null,
}

const preflightEnvelope = await makePreflightEnvelope()
let preflightVerifyValid = true // toggled by individual tests

function baseDeps(overrides: Record<string, unknown> = {}) {
  const preflightVerified = preflightVerifyValid
  return {
    peekCapability: async (): Promise<CapabilityRecord | null> => ({
      capabilityHash: 'hash',
      preflightReceiptId: preflightEnvelope.receipt.receipt_id,
      preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
      expiresAt: '2099-01-01T00:00:00.000Z',
      usedAt: null,
      consumedTransactionHash: null,
      commerceReceiptId: null,
      publishCommerce: false,
    }),
    getReceiptForFinalization: async () => ({ envelope: preflightEnvelope, isPublic: false }),
    observeTransaction: async () => SUCCESS_OBSERVATION,
    signReceipt: fakeSignReceipt,
    fetchKeyRegistry: async () => (preflightVerified ? fakeRegistry : []),
    consumeCapabilityAndPublish: async () => ({ kind: 'consumed' as const }),
    ...overrides,
  }
}

const VALID_BODY = { transaction_hash: TX_HASH, execution_provider: 'x402' as const, provider_reference: null, result_digest: null }

// --- auth --------------------------------------------------------------

await assert.rejects(() => finalizePayment(null, VALID_BODY, baseDeps()), FinalizationAuthError)
await assert.rejects(() => finalizePayment('NotBearer xyz', VALID_BODY, baseDeps()), FinalizationAuthError)
await assert.rejects(
  () => finalizePayment('Bearer sometoken', VALID_BODY, baseDeps({ peekCapability: async () => null })),
  FinalizationAuthError
)
console.log('ok  missing/malformed/unknown capability -> FinalizationAuthError')

await assert.rejects(
  () =>
    finalizePayment(
      'Bearer sometoken',
      VALID_BODY,
      baseDeps({
        peekCapability: async () => ({
          capabilityHash: 'hash',
          preflightReceiptId: preflightEnvelope.receipt.receipt_id,
          preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
          expiresAt: '2000-01-01T00:00:00.000Z', // already expired
          usedAt: null,
          consumedTransactionHash: null,
          commerceReceiptId: null,
          publishCommerce: false,
        }),
      })
    ),
  FinalizationAuthError
)
console.log('ok  expired capability -> FinalizationAuthError')

// --- input validation ----------------------------------------------------

for (const forbidden of ['amount', 'recipient', 'asset', 'sender', 'network']) {
  await assert.rejects(
    () => finalizePayment('Bearer sometoken', { ...VALID_BODY, [forbidden]: 'should-not-be-allowed' }, baseDeps()),
    FinalizationInputError,
    `${forbidden} must be rejected as caller-supplied`
  )
}
console.log('ok  caller-supplied amount/recipient/asset/sender/network all rejected')

await assert.rejects(() => finalizePayment('Bearer x', { ...VALID_BODY, transaction_hash: 'not-a-hash' }, baseDeps()), FinalizationInputError)
await assert.rejects(() => finalizePayment('Bearer x', { ...VALID_BODY, execution_provider: 'unknown-provider' }, baseDeps()), FinalizationInputError)
console.log('ok  malformed transaction_hash / execution_provider rejected')

// --- unsupported settlement scope ----------------------------------------

await assert.rejects(
  () =>
    finalizePayment(
      'Bearer x',
      VALID_BODY,
      baseDeps({
        observeTransaction: async () => {
          throw new UnsupportedSettlementScopeError('eip155:1', USDC)
        },
      })
    ),
  FinalizationInputError
)
console.log('ok  unsupported network/asset surfaces as a clear input error, not a 500')

// --- D2.2B2: transient/retryable observations must NOT consume the capability ---

{
  const NOT_FOUND_OBSERVATION: SettlementObservation = {
    state: 'not-found',
    blockNumber: null,
    blockTimestamp: null,
    confirmations: null,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: null,
  }
  let consumeCalled = false
  const err = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      observeTransaction: async () => NOT_FOUND_OBSERVATION,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' }
      },
    })
  ).catch((e) => e)
  assert.ok(err instanceof FinalizationPendingError, 'transaction not yet found must be retryable, not a hard failure')
  assert.equal(err.reason, 'transaction-not-found')
  assert.equal(err.httpStatus, 425)
  assert.equal(consumeCalled, false, 'the capability must not be consumed while the transaction is not yet found')
}
console.log('ok  transaction not yet found -> FinalizationPendingError (425), capability NOT consumed')

{
  const RPC_UNAVAILABLE_OBSERVATION: SettlementObservation = {
    state: 'rpc-unavailable',
    blockNumber: null,
    blockTimestamp: null,
    confirmations: null,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: 'Block at number "50883116" could not be found.',
  }
  let consumeCalled = false
  const err = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      observeTransaction: async () => RPC_UNAVAILABLE_OBSERVATION,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' }
      },
    })
  ).catch((e) => e)
  assert.ok(err instanceof FinalizationPendingError, 'RPC unavailable must be retryable, not a hard failure')
  assert.equal(err.reason, 'rpc-unavailable')
  assert.equal(err.httpStatus, 503)
  assert.ok(err.message.includes('50883116'), 'the safe RPC error detail should be surfaced')
  assert.equal(consumeCalled, false, 'the capability must not be consumed while the RPC is unavailable')
}
console.log('ok  RPC unavailable -> FinalizationPendingError (503), capability NOT consumed')

{
  const INSUFFICIENT_CONFIRMATIONS_OBSERVATION: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 1,
    sufficientlyConfirmed: false, // observed, but not yet deep enough
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  let consumeCalled = false
  const err = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      observeTransaction: async () => INSUFFICIENT_CONFIRMATIONS_OBSERVATION,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' }
      },
    })
  ).catch((e) => e)
  assert.ok(err instanceof FinalizationPendingError, 'insufficient confirmations must be retryable, not a hard failure')
  assert.equal(err.reason, 'insufficient-confirmations')
  assert.equal(err.httpStatus, 425)
  assert.equal(consumeCalled, false, 'the capability must not be consumed before the required confirmation depth is reached')
}
console.log('ok  successful tx with insufficient confirmations -> FinalizationPendingError (425), capability NOT consumed')

// --- reverted transaction IS definitive: a real (FAILED) Commerce Receipt --

{
  const REVERTED_OBSERVATION: SettlementObservation = {
    state: 'reverted',
    blockNumber: 100n,
    blockTimestamp: null,
    confirmations: null,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: null,
  }
  let consumeCalledWith: any = null
  const result = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      observeTransaction: async () => REVERTED_OBSERVATION,
      consumeCapabilityAndPublish: async (params: any) => {
        consumeCalledWith = params
        return { kind: 'consumed' }
      },
    })
  )
  assert.equal(result.envelope.receipt.execution.status, 'FAILED')
  assert.equal(result.envelope.receipt.settlement.status, 'NOT_CONFIRMED')
  assert.ok(consumeCalledWith, 'a reverted transaction is DEFINITIVE -- it must finalize (and consume), not stay pending forever')
}
console.log('ok  reverted transaction is definitive -> finalizes immediately as FAILED/NOT_CONFIRMED, capability consumed')

// --- HTTP adapter maps FinalizationPendingError to 425/503 with Retry-After ---

{
  const { Hono } = await import('hono')
  const { createFinalizePostHandler } = await import('../src/finalizeRoute.js')

  const app = new Hono()
  app.post(
    '/receipts/finalize',
    createFinalizePostHandler(
      baseDeps({
        observeTransaction: async (): Promise<SettlementObservation> => ({
          state: 'not-found',
          blockNumber: null,
          blockTimestamp: null,
          confirmations: null,
          sufficientlyConfirmed: false,
          transfers: [],
          rpcError: null,
        }),
      })
    )
  )
  const res = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
    method: 'POST',
    headers: { Authorization: 'Bearer pending-probe-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  })
  assert.equal(res.status, 425)
  assert.equal(res.headers.get('retry-after'), '10')
}
console.log('ok  HTTP adapter maps a retryable observation to 425 with Retry-After')

// --- preflight validity gate ----------------------------------------------

preflightVerifyValid = false
await assert.rejects(() => finalizePayment('Bearer x', VALID_BODY, baseDeps()), FinalizationServiceError)
preflightVerifyValid = true
console.log('ok  bound preflight receipt failing VALID verification blocks finalization')

// --- successful finalization ----------------------------------------------

{
  let consumeCalledWith: any = null
  const result = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      consumeCapabilityAndPublish: async (params: any) => {
        consumeCalledWith = params
        return { kind: 'consumed' }
      },
    })
  )
  assert.equal(result.idempotentReplay, false)
  assert.equal(result.envelope.receipt.receipt_type, 'COMMERCE')
  assert.equal(result.envelope.receipt.links.preflight_receipt_id, preflightEnvelope.receipt.receipt_id)
  assert.equal(result.envelope.receipt.settlement.status, 'CONFIRMED')
  assert.ok(consumeCalledWith, 'consumeCapabilityAndPublish must be called only after a VALID receipt exists')
  assert.equal(consumeCalledWith.transactionHash, TX_HASH)
  assert.equal(consumeCalledWith.isPublic, false) // publishCommerce was false in baseDeps' capability record
}
console.log('ok  successful finalization produces a VALID COMMERCE receipt and consumes the capability last')

// --- generated receipt fails VALID verification -> capability never consumed ---

{
  let consumeCalled = false
  await assert.rejects(
    () =>
      finalizePayment(
        'Bearer x',
        VALID_BODY,
        baseDeps({
          fetchKeyRegistry: async () => fakeRegistry, // valid for the preflight check...
          signReceipt: async () => ({ signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: 'https://wrong-issuer.example', purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issued_at: new Date().toISOString(), key_id: KEY_ID, algorithm: 'ed25519', signature: 'x'.repeat(86) }), // ...but the COMMERCE receipt's own signature is bogus (wrong issuer)
          consumeCapabilityAndPublish: async () => {
            consumeCalled = true
            return { kind: 'consumed' }
          },
        })
      ),
    FinalizationServiceError
  )
  assert.equal(consumeCalled, false, 'the capability must never be consumed if the generated receipt does not verify VALID')
}
console.log('ok  capability is never consumed if the generated Commerce Receipt fails VALID verification')

// --- idempotent replay: same capability + same tx -> existing receipt, no new work ---

{
  const existingCommerce = { ...preflightEnvelope, receipt: { ...preflightEnvelope.receipt, receipt_type: 'COMMERCE' as const, receipt_id: 'OCD-RCP-EXISTING-0000-0000-0000' } }
  let observeCalled = false
  let signCalled = false
  const result = await finalizePayment(
    'Bearer x',
    VALID_BODY,
    baseDeps({
      peekCapability: async (): Promise<CapabilityRecord> => ({
        capabilityHash: 'hash',
        preflightReceiptId: preflightEnvelope.receipt.receipt_id,
        preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
        expiresAt: '2099-01-01T00:00:00.000Z',
        usedAt: '2026-09-04T00:02:00.000Z',
        consumedTransactionHash: TX_HASH,
        commerceReceiptId: 'OCD-RCP-EXISTING-0000-0000-0000',
        publishCommerce: false,
      }),
      getReceiptForFinalization: async (id: string) => {
        if (id === 'OCD-RCP-EXISTING-0000-0000-0000') return { envelope: existingCommerce, isPublic: false }
        return { envelope: preflightEnvelope, isPublic: false }
      },
      observeTransaction: async () => {
        observeCalled = true
        return SUCCESS_OBSERVATION
      },
      signReceipt: async (r: Receipt) => {
        signCalled = true
        return fakeSignReceipt(r)
      },
    })
  )
  assert.equal(result.idempotentReplay, true)
  assert.equal(result.envelope.receipt.receipt_id, 'OCD-RCP-EXISTING-0000-0000-0000')
  assert.equal(observeCalled, false, 'a replay must not re-observe the chain')
  assert.equal(signCalled, false, 'a replay must not re-sign anything')
}
console.log('ok  same capability + same transaction hash -> idempotent replay, no new chain/signing work')

// --- same capability + different tx after consumption -> reject ----------

await assert.rejects(
  () =>
    finalizePayment(
      'Bearer x',
      { ...VALID_BODY, transaction_hash: OTHER_TX_HASH },
      baseDeps({
        peekCapability: async (): Promise<CapabilityRecord> => ({
          capabilityHash: 'hash',
          preflightReceiptId: preflightEnvelope.receipt.receipt_id,
          preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
          expiresAt: '2099-01-01T00:00:00.000Z',
          usedAt: '2026-09-04T00:02:00.000Z',
          consumedTransactionHash: TX_HASH, // different from the request's OTHER_TX_HASH
          commerceReceiptId: 'OCD-RCP-EXISTING-0000-0000-0000',
          publishCommerce: false,
        }),
      })
    ),
  FinalizationConflictError
)
console.log('ok  same capability + a DIFFERENT transaction hash after consumption -> rejected')

// --- race at the atomic layer: consumeCapabilityAndPublish reports the outcome ---

await assert.rejects(
  () => finalizePayment('Bearer x', VALID_BODY, baseDeps({ consumeCapabilityAndPublish: async () => ({ kind: 'consumed-different-tx' }) })),
  FinalizationConflictError
)
await assert.rejects(
  () => finalizePayment('Bearer x', VALID_BODY, baseDeps({ consumeCapabilityAndPublish: async () => ({ kind: 'expired' }) })),
  FinalizationAuthError
)
console.log('ok  a race detected only at the atomic consume step is still reported correctly')

// --- the raw capability is never logged -----------------------------------

{
  const logged: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  const secretToken = 'Bearer super-secret-capability-token-value-xyz'
  try {
    await finalizePayment(secretToken, VALID_BODY, baseDeps())
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.ok(!logged.some((line) => line.includes('super-secret-capability-token-value-xyz')), 'the raw capability token must never be logged')
}
console.log('ok  the raw capability token is never logged')

// --- HTTP adapter: status-code mapping ------------------------------------

{
  const { Hono } = await import('hono')
  const { createFinalizePostHandler } = await import('../src/finalizeRoute.js')

  const app = new Hono()
  app.post('/receipts/finalize', createFinalizePostHandler(baseDeps()))

  const ok = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
    method: 'POST',
    headers: { Authorization: 'Bearer sometoken', 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  })
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as any
  assert.equal(body.receipt.receipt_type, 'COMMERCE')

  const noAuth = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  })
  assert.equal(noAuth.status, 401)
  assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer realm="finalization"')

  const badInput = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
    method: 'POST',
    headers: { Authorization: 'Bearer sometoken', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...VALID_BODY, amount: '1.00' }),
  })
  assert.equal(badInput.status, 400)

  const malformedJson = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
    method: 'POST',
    headers: { Authorization: 'Bearer sometoken', 'Content-Type': 'application/json' },
    body: 'not json',
  })
  assert.equal(malformedJson.status, 400)
}
console.log('ok  HTTP adapter maps auth/input/success to 401/400/200 correctly')

{
  const { Hono } = await import('hono')
  const { createFinalizePostHandler } = await import('../src/finalizeRoute.js')

  // A distinct capability hash per this block so the rate-limit window
  // (shared module-level state) doesn't bleed into other tests.
  const app = new Hono()
  app.post('/receipts/finalize', createFinalizePostHandler(baseDeps({ consumeCapabilityAndPublish: async () => ({ kind: 'consumed-different-tx' }) })))
  const rateLimitToken = 'Bearer rate-limit-probe-token-unique-xyz'
  let last429 = false
  for (let i = 0; i < 25; i++) {
    const res = await app.request('https://mcp.onchaindiligence.com/receipts/finalize', {
      method: 'POST',
      headers: { Authorization: rateLimitToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })
    if (res.status === 429) last429 = true
  }
  assert.ok(last429, 'rapid repeated attempts against the same capability must eventually be rate-limited')
}
console.log('ok  rapid repeated attempts against the same capability are rate-limited (429)')

console.log('\nAll D2.2 finalization orchestration tests passed.')
