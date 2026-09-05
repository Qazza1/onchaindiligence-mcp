/** D2.4 (Section 4/12, acceptance criteria #4/#7/#9, Section 15 tests #1/#9):
 * resumable, operation-bound paid preflight. The core catastrophic-
 * regression scenario D2.4 exists to fix: a lost response after the OCD fee
 * settles must never require a second fee, and a crash between "payment
 * confirmed" and "result stored" must resume to ONE frozen result, never
 * produce two receipts with different content/timestamps.
 *
 * Run with: npx tsx test/d24LifecyclePreflight.ts
 *
 * Fully offline: signing/key-registry/storage/capability-minting are all
 * injected fakes (the exact same seams preflightPayment() itself exposes —
 * see test/preflight.ts), and a `paymentAttempts` counter stands in for the
 * real x402 payment middleware, which this suite never constructs (no CDP
 * credentials, no network). What's under test is entirely OUR gate logic:
 * whether payment middleware would be invoked a second time, not the real
 * facilitator's own retry behavior.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import type { Receipt, PublicActionReceiptEnvelope } from '../src/receipts.js'
import type { LifecycleStepDependencies } from '../src/lifecycleSteps.js'
import type { LifecycleStepRow } from '../src/db.js'
import type { CommerceOperationRecord } from '../src/db.js'

process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

const { Hono } = await import('hono')
const { createLifecyclePreflightGate, createLifecyclePreflightHandler, OPERATION_HEADER, RECOVERY_HEADER } = await import(
  '../src/lifecycleRoute.js'
)
const { hashRecoveryCredential } = await import('../src/operation.js')
const { receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE } = await import('../src/receipts.js')

// --- fake signer, mirroring test/preflight.ts exactly ---------------------

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const TEST_KEY_ID = 'ed25519-TESTKEYFORD24PF01'
const fakeRegistry = [{ key_id: TEST_KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null }]
async function fakeSignReceipt(receipt: Receipt): Promise<PublicActionReceiptEnvelope['proof']> {
  const issued_at = new Date().toISOString()
  const signingInput = receiptAttestationSigningInput(receipt, {
    issuer: PUBLIC_ACTION_RECEIPT_ISSUER,
    purpose: PUBLIC_ACTION_RECEIPT_PURPOSE,
    issuedAt: issued_at,
    keyId: TEST_KEY_ID,
  })
  const signature = ed25519Sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return {
    signed: true,
    schema_version: 'onchaindiligence.attestation.v2',
    issuer: PUBLIC_ACTION_RECEIPT_ISSUER,
    purpose: PUBLIC_ACTION_RECEIPT_PURPOSE,
    issued_at,
    key_id: TEST_KEY_ID,
    algorithm: 'ed25519',
    canonicalization: 'RFC8785',
    signature,
  }
}

// --- fake operation store + fake step journal ------------------------------

const OPERATION_ID = 'OCD-OP-' + 'A'.repeat(27)
const RECOVERY_CREDENTIAL = 'the-real-recovery-credential-0123456789'

function makeFakeOperationStore() {
  const op: CommerceOperationRecord = {
    operationId: OPERATION_ID,
    recoveryCredentialHash: hashRecoveryCredential(RECOVERY_CREDENTIAL),
    preflightState: 'not_started',
    executionState: 'not_submitted',
    observationState: 'none',
    receiptState: 'none',
    preflightReceiptId: null,
    createdAt: new Date().toISOString(),
  }
  return {
    authenticateOperation: async (operationId: string, credential: string | null | undefined) => {
      if (operationId !== op.operationId) return null
      if (!credential || hashRecoveryCredential(credential) !== op.recoveryCredentialHash) return null
      return op
    },
    updateCommerceOperationState: async (operationId: string, fields: Partial<CommerceOperationRecord>) => {
      if (operationId === op.operationId) Object.assign(op, fields)
    },
    op,
  }
}

function makeFakeStepStore() {
  const rows = new Map<string, LifecycleStepRow>() // key: operationId + '\0' + stepKey
  const step: LifecycleStepDependencies = {
    claimLifecycleStep: async (params) => {
      const key = `${params.operationId}\0${params.stepKey}`
      const existing = rows.get(key)
      if (existing) return { claimed: false, row: existing }
      const row: LifecycleStepRow = {
        operationId: params.operationId,
        stepKey: params.stepKey,
        inputDigest: params.inputDigest,
        status: 'claimed',
        frozenInput: params.frozenInput,
        capabilityToken: null,
        capabilityExpiresAt: null,
        resultJson: null,
      }
      rows.set(key, row)
      return { claimed: true, row }
    },
    markLifecycleStepPaid: async (operationId, stepKey) => {
      const row = rows.get(`${operationId}\0${stepKey}`)
      if (row && row.status === 'claimed') row.status = 'paid'
    },
    setLifecycleStepCapability: async (operationId, stepKey, token, expiresAt) => {
      const row = rows.get(`${operationId}\0${stepKey}`)
      if (row && !row.capabilityToken) {
        row.capabilityToken = token
        row.capabilityExpiresAt = expiresAt
      }
    },
    completeLifecycleStep: async (operationId, stepKey, resultJson) => {
      const row = rows.get(`${operationId}\0${stepKey}`)
      if (row) {
        row.status = 'completed'
        row.resultJson = resultJson
      }
    },
    getLifecycleStep: async (operationId, stepKey) => rows.get(`${operationId}\0${stepKey}`) ?? null,
  }
  return { step, rows }
}

function baseBody() {
  return {
    action: {
      kind: 'PAYMENT',
      resource: 'https://service.example/api',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1.00',
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
    },
    policy: {
      max_amount: '5.00',
      allowed_networks: ['eip155:8453'],
      allowed_assets: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      expected_recipient: null,
      allowed_resource_origins: ['https://service.example'],
    },
    options: {},
    references: {},
  }
}

let mintCount = 0
async function fakeMintCapability(preflightReceiptId: string, preflightReceiptDigest: string) {
  mintCount++
  return { token: `capability-${mintCount}-${preflightReceiptId}`, expiresAt: '2099-01-01T00:00:00.000Z' }
}

function buildTestApp(opStore: ReturnType<typeof makeFakeOperationStore>, stepStore: ReturnType<typeof makeFakeStepStore>) {
  const paymentCalls: number[] = []
  const deps = {
    authenticateOperation: opStore.authenticateOperation,
    updateCommerceOperationState: opStore.updateCommerceOperationState,
    step: stepStore.step,
    mintCapability: fakeMintCapability,
    preflightDeps: { signReceipt: fakeSignReceipt, fetchKeyRegistry: async () => fakeRegistry, storeReceipt: async () => {} },
  }
  const app = new Hono()
  app.use('/preflight', createLifecyclePreflightGate(deps))
  // Stand-in for the real x402 payment middleware: records that it ran, then
  // always "succeeds". What matters for these tests is whether this ever
  // runs a SECOND time for the same payment, not the facilitator's own logic.
  app.use('/preflight', async (c, next) => {
    paymentCalls.push(Date.now())
    await next()
  })
  app.post('/preflight', createLifecyclePreflightHandler(deps))
  return { app, paymentCalls }
}

function headers(extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', [OPERATION_HEADER]: OPERATION_ID, [RECOVERY_HEADER]: RECOVERY_CREDENTIAL, ...extra }
}

// --- fresh request succeeds, exactly one payment attempt -------------------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  const res = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.receipt.receipt.receipt_type, 'PREFLIGHT')
  assert.equal(paymentCalls.length, 1, 'a fresh request must go through payment exactly once')
  assert.equal(opStore.op.preflightState, 'completed')
  assert.equal(opStore.op.preflightReceiptId, body.receipt.receipt.receipt_id)
}
console.log('ok  a fresh operation-bound preflight request succeeds with exactly one payment attempt')

// --- D2.4 Section 15 test #1: a completed step replays without any payment ---

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  const first = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  const firstBody = (await first.json()) as any
  assert.equal(paymentCalls.length, 1)

  // The client never saw the response (simulated: it just retries the exact
  // same request over the exact same operation).
  const second = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(second.status, 200)
  const secondBody = (await second.json()) as any
  assert.deepEqual(secondBody, firstBody, 'a replay of a completed step must return the byte-identical result')
  assert.equal(paymentCalls.length, 1, 'a replay of an already-completed step must NEVER trigger a second payment attempt')
}
console.log('ok  retrying a COMPLETED preflight step returns the identical result with zero additional payment attempts')

// --- D2.4 Section 15 tests #1 & #9: crash after payment, before completion -> resume, one frozen result, no second fee ---

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  // Simulate the real failure mode directly: a step was claimed AND payment
  // was confirmed (status 'paid'), but the process crashed before ever
  // completing the receipt-building work or returning a response. This is
  // constructed by hand (not by aborting a real request) so the test
  // proves the RESUME path specifically, not just retry-after-success.
  const { parsePreflightInput } = await import('../src/preflight.js')
  const input = parsePreflightInput(baseBody())
  const { contentId } = await import('../src/receipts.js')
  const inputDigest = contentId(input)
  const frozenIssuedAt = '2026-09-05T00:00:00.000Z'
  await stepStore.step.claimLifecycleStep!({ operationId: OPERATION_ID, stepKey: 'preflight', inputDigest, frozenInput: { input, issuedAt: frozenIssuedAt } })
  await stepStore.step.markLifecycleStepPaid!(OPERATION_ID, 'preflight')

  const mintCountBefore = mintCount
  const res = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.receipt.receipt.receipt_type, 'PREFLIGHT')
  assert.equal(body.receipt.receipt.issued_at, frozenIssuedAt, 'the resumed receipt must use the FROZEN issued_at, never a fresh timestamp')
  assert.equal(paymentCalls.length, 0, 'resuming an already-paid step must NEVER invoke payment middleware again')
  assert.equal(mintCount, mintCountBefore + 1, 'exactly one capability is minted for the resumed step')

  // A SECOND resume attempt (e.g. the response is lost again) must reuse the
  // SAME cached capability, never mint a second one, and never re-pay.
  const res2 = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  const body2 = (await res2.json()) as any
  assert.deepEqual(body2, body, 'a second replay after completion returns the identical frozen result')
  assert.equal(mintCount, mintCountBefore + 1, 'a capability already minted for this step must never be minted twice')
  assert.equal(paymentCalls.length, 0)
}
console.log('ok  resuming a paid-but-incomplete step produces ONE frozen result (same issued_at, same capability), with zero additional payment attempts')

// --- D2.5A incident: a step claimed but never paid (e.g. an unpaid price
// probe reading the live 402 challenge before any payment is attempted)
// must not permanently block a LATER request from completing that same
// payment -- it previously 425'd forever, with no way to ever resume. See
// lifecycleRoute.ts's header ("UNPAID PROBES CAN PERMANENTLY CLAIM A STEP").

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  // Simulate exactly what a price probe leaves behind: the step claimed,
  // with no payment ever attempted against it (claimLifecycleStep alone,
  // never markLifecycleStepPaid).
  const { parsePreflightInput } = await import('../src/preflight.js')
  const { contentId } = await import('../src/receipts.js')
  const input = parsePreflightInput(baseBody())
  const inputDigest = contentId(input)
  await stepStore.step.claimLifecycleStep!({ operationId: OPERATION_ID, stepKey: 'preflight', inputDigest, frozenInput: { input, issuedAt: new Date().toISOString() } })

  // A later request for the SAME operation + step + input must still be
  // able to reach payment middleware and complete -- never stuck at 425.
  const res = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(res.status, 200, 'a step claimed by an earlier unpaid probe must still be resumable to a real payment attempt')
  const body = (await res.json()) as any
  assert.equal(body.receipt.receipt.receipt_type, 'PREFLIGHT')
  assert.equal(paymentCalls.length, 1, 'the resumed request must actually reach payment middleware exactly once')
  assert.equal(opStore.op.preflightState, 'completed')
}
console.log('ok  a step left claimed-but-unpaid by an earlier request (e.g. a price probe) can still be resumed to a real payment attempt, not stuck at 425 forever')

// --- same operation, DIFFERENT input -> explicit conflict, not silently reused ---

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  const differentBody = { ...baseBody(), action: { ...baseBody().action, amount: '2.00' } }
  const res = await app.request('/preflight', { method: 'POST', headers: headers(), body: JSON.stringify(differentBody) })
  assert.equal(res.status, 409, 'the SAME operation + SAME step key + a DIFFERENT input digest must be an explicit conflict')
  assert.equal(paymentCalls.length, 1, 'the conflicting second request must never reach payment')
}
console.log('ok  same operation + same step + different input is an explicit 409 conflict, never silently reused or double-paid')

// --- auth failures never reach payment --------------------------------------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const { app, paymentCalls } = buildTestApp(opStore, stepStore)

  const noOpHeader = await app.request('/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody()) })
  assert.equal(noOpHeader.status, 400)

  const wrongCredential = await app.request('/preflight', {
    method: 'POST',
    headers: headers({ [RECOVERY_HEADER]: 'wrong-credential' }),
    body: JSON.stringify(baseBody()),
  })
  assert.equal(wrongCredential.status, 401)
  assert.equal(paymentCalls.length, 0, 'no auth failure may ever reach payment')
}
console.log('ok  missing operation header / wrong recovery credential are rejected before payment is ever attempted')

console.log('\nAll D2.4 resumable lifecycle preflight tests passed.')
