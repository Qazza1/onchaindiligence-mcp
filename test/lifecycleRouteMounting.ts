/**
 * lifecycleRouteMounting.ts — regression test for a confirmed live D2.5A
 * defect: POST /x402/lifecycle/preflight-payment was reachable and would
 * complete (evaluating and signing a real PREFLIGHT receipt) WITHOUT ever
 * going through payment middleware, in production.
 *
 * Root cause: index.ts called mountLifecycle(app) — which used to register
 * BOTH the pre-payment gate AND the terminal POST handler for this exact
 * path — before mountDiscovery(app) ever mounted its broad `/x402/*`
 * paymentMiddleware. Hono composes handlers matching a path in
 * REGISTRATION order, not specificity order, so the terminal handler
 * (registered first) answered and ended the chain before payment
 * middleware (registered later) was ever inserted between the gate and the
 * handler. test/d24LifecyclePreflight.ts did not catch this because it
 * wires the gate/fake-payment/handler chain manually in the correct order
 * itself, rather than exercising the actual exported mount functions in the
 * actual order index.ts uses.
 *
 * This test exercises exactly that: the real mountLifecycle() +
 * mountLifecyclePreflightHandler() exports, mounted on the real path, with
 * a stand-in broad `/x402/*` middleware registered BETWEEN them -- the same
 * shape index.ts now uses (mountLifecycle -> mountDiscovery ->
 * mountLifecyclePreflightHandler).
 *
 * Run with: npx tsx test/lifecycleRouteMounting.ts
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
const { mountLifecycle, mountLifecyclePreflightHandler, OPERATION_HEADER, RECOVERY_HEADER } = await import('../src/lifecycleRoute.js')
const { hashRecoveryCredential } = await import('../src/operation.js')
const { receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE } = await import('../src/receipts.js')

// --- fake signer, mirroring test/d24LifecyclePreflight.ts exactly ----------

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const TEST_KEY_ID = 'ed25519-TESTKEYFORMOUNT01'
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

// --- fake operation store + fake step journal (same shape as d24LifecyclePreflight.ts) ---

const OPERATION_ID = 'OCD-OP-' + 'B'.repeat(27)
const RECOVERY_CREDENTIAL = 'the-real-recovery-credential-9876543210'

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
  const rows = new Map<string, LifecycleStepRow>()
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

function headers(extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', [OPERATION_HEADER]: OPERATION_ID, [RECOVERY_HEADER]: RECOVERY_CREDENTIAL, ...extra }
}

const PATH = '/x402/lifecycle/preflight-payment'

function buildDeps(opStore: ReturnType<typeof makeFakeOperationStore>, stepStore: ReturnType<typeof makeFakeStepStore>) {
  return {
    authenticateOperation: opStore.authenticateOperation,
    updateCommerceOperationState: opStore.updateCommerceOperationState,
    step: stepStore.step,
    mintCapability: fakeMintCapability,
    preflightDeps: { signReceipt: fakeSignReceipt, fetchKeyRegistry: async () => fakeRegistry, storeReceipt: async () => {} },
  }
}

// --- 1. Mounted in the CORRECT (fixed) order: a fresh request must pass
// through payment middleware before the terminal handler ever runs -------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const deps = buildDeps(opStore, stepStore)
  let paymentMiddlewareRuns = 0

  const app = new Hono()
  mountLifecycle(app, deps) // gate only -- same call index.ts makes, BEFORE the broad payment middleware
  app.use('/x402/*', async (c, next) => {
    // Stand-in for mountDiscovery's real paymentMiddleware(X402_ROUTES, resourceServer).
    paymentMiddlewareRuns++
    await next()
  })
  mountLifecyclePreflightHandler(app, deps) // terminal handler -- same call index.ts makes, AFTER the broad payment middleware

  const res = await app.request(PATH, { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.receipt.receipt.receipt_type, 'PREFLIGHT')
  assert.equal(paymentMiddlewareRuns, 1, 'the terminal handler must never run without payment middleware running first')
}
console.log('ok  mountLifecycle() -> broad /x402/* middleware -> mountLifecyclePreflightHandler(): payment middleware runs exactly once before the handler completes')

// --- 2. The terminal handler must be UNREACHABLE if the broad payment
// middleware short-circuits (e.g. demands a real 402) -- proves the
// handler is genuinely gated, not just "counted" ---------------------------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const deps = buildDeps(opStore, stepStore)
  const mintCountBefore = mintCount

  const app = new Hono()
  mountLifecycle(app, deps)
  app.use('/x402/*', async (c) => {
    // A real paymentMiddleware short-circuits with 402 when no payment
    // header is present -- it never calls next().
    return c.json({ error: 'payment required (simulated 402)' }, 402)
  })
  mountLifecyclePreflightHandler(app, deps) // registered AFTER the short-circuiting middleware above -- must never run

  const res = await app.request(PATH, { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(res.status, 402, 'an unpaid request must be rejected by payment middleware, never reach the terminal handler')
  assert.equal(opStore.op.preflightState, 'not_started', 'no evaluation may occur, and no receipt may be issued, before payment settles')
  assert.equal(mintCount, mintCountBefore, 'no capability may be minted before payment settles')
}
console.log('ok  when payment middleware short-circuits with 402, the terminal handler never runs and no receipt is issued')

// --- 3. The gate's own pre-payment validation still runs, and still runs
// BEFORE payment middleware, when mounted via the real split functions --
// a malformed body must never reach (or pay) the broad middleware --------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const deps = buildDeps(opStore, stepStore)
  let paymentMiddlewareRuns = 0

  const app = new Hono()
  mountLifecycle(app, deps)
  app.use('/x402/*', async (c, next) => {
    paymentMiddlewareRuns++
    await next()
  })
  mountLifecyclePreflightHandler(app, deps)

  const res = await app.request(PATH, { method: 'POST', headers: headers(), body: JSON.stringify({ action: { kind: 'PAYMENT' } }) })
  assert.equal(res.status, 400, 'a malformed body must be rejected by the gate, not reach the handler')
  assert.equal(paymentMiddlewareRuns, 0, "the gate's own input validation must reject before payment middleware ever runs")
}
console.log("ok  the gate's pre-payment input validation still runs, and still runs before payment middleware, in the fixed mount order")

// --- 4. D2.4 Section 4's core guarantee, re-proven through the real split
// mount functions: a recognized retry of an ALREADY-COMPLETED step is
// served directly by the gate -- no second payment-middleware invocation,
// no second evaluation, no second receipt -------------------------------

{
  const opStore = makeFakeOperationStore()
  const stepStore = makeFakeStepStore()
  const deps = buildDeps(opStore, stepStore)
  let paymentMiddlewareRuns = 0

  const app = new Hono()
  mountLifecycle(app, deps)
  app.use('/x402/*', async (c, next) => {
    paymentMiddlewareRuns++
    await next()
  })
  mountLifecyclePreflightHandler(app, deps)

  const first = await app.request(PATH, { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(first.status, 200)
  const firstBody = (await first.json()) as any
  assert.equal(paymentMiddlewareRuns, 1)

  // The client never saw the response (simulated: it just retries the exact
  // same request over the exact same operation) -- this must be served from
  // the gate's own "completed" branch, never touching payment middleware
  // again, regardless of how the terminal handler is mounted relative to it.
  const second = await app.request(PATH, { method: 'POST', headers: headers(), body: JSON.stringify(baseBody()) })
  assert.equal(second.status, 200)
  const secondBody = (await second.json()) as any
  assert.equal(secondBody.receipt.receipt.receipt_id, firstBody.receipt.receipt.receipt_id, 'a retry must return the IDENTICAL receipt, never a second one')
  assert.equal(paymentMiddlewareRuns, 1, 'a recognized retry of a completed step must never invoke payment middleware a second time')
}
console.log('ok  a recognized retry of an already-completed step is served by the gate directly, with zero additional payment-middleware invocations, in the fixed mount order')

console.log('\nAll lifecycle route mounting-order regression tests passed.')
