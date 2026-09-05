/** D2.1A focused tests for the free inspect_payment primitive.
 *
 * Run with: npx tsx test/inspectPayment.ts
 *
 * Fully offline and dependency-free: inspectPayment() never imports attest()
 * or fetch()-based sanctions screening in its own code path (only
 * preflightPayment does, gated behind options.screen_recipient_sanctions,
 * which the free parser rejects outright) — this file blocks all network
 * access to make that a hard guarantee, not just an inspection of the code.
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'

// If inspectPayment ever tried a network call, this file would fail loudly
// rather than silently succeed against a live service.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

import {
  inspectPayment,
  parseInspectInput,
  preflightPayment,
  PreflightInputError,
} from '../src/preflight.js'
import { mountInspect } from '../src/inspectRoute.js'
import { receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE } from '../src/receipts.js'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import type { Receipt, PublicActionReceiptEnvelope } from '../src/receipts.js'

function baseInput(overrides: Record<string, unknown> = {}): unknown {
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
    ...overrides,
  }
}

// --- input parsing: free tier is strictly {action, policy} --------------

assert.throws(() => parseInspectInput(null), PreflightInputError)
assert.throws(() => parseInspectInput({}), PreflightInputError)
assert.doesNotThrow(() => parseInspectInput(baseInput()))
assert.throws(
  () => parseInspectInput(baseInput({ options: { screen_recipient_sanctions: true } })),
  /not available on the free inspection endpoint/,
  'sanctions screening must be explicitly rejected on the free tier, never silently dropped'
)
assert.doesNotThrow(
  () => parseInspectInput(baseInput({ options: { screen_recipient_sanctions: false } })),
  'an explicit false is fine — only true is rejected'
)
console.log('ok  free input parsing: {action, policy} only, screen_recipient_sanctions:true rejected')

// --- deterministic decision rules, identical to D2.1's precedence -------

{
  const result = await inspectPayment(baseInput({ policy: { ...(baseInput() as any).policy, max_amount: '5.00' }, action: { ...(baseInput() as any).action, amount: '4.99' } }))
  assert.equal(result.decision.status, 'ALLOW')
  assert.equal(result.decision.authorized, true)
}
console.log('ok  free inspect: amount below max -> ALLOW')

{
  const input = baseInput() as any
  input.action.amount = '5.01'
  const result = await inspectPayment(input)
  assert.equal(result.decision.status, 'BLOCK')
  assert.equal(result.decision.authorized, false)
  assert.ok(result.checks.find((c) => c.id === 'amount-within-max' && c.result === 'FAIL'))
}
console.log('ok  free inspect: amount above max -> BLOCK')

{
  const input = baseInput() as any
  input.action.resource = null // origin policy is configured, but nothing to check it against
  const result = await inspectPayment(input)
  assert.equal(result.decision.status, 'REQUIRE_APPROVAL')
  assert.ok(result.checks.find((c) => c.id === 'resource-origin-allowed' && c.result === 'UNKNOWN'))
}
console.log('ok  free inspect: missing required resource with origin policy configured -> REQUIRE_APPROVAL')

// --- no external evidence, no signing, no receipt ------------------------

{
  const result = await inspectPayment(baseInput())
  assert.equal(result.evidence.external_checks_performed, false)
  assert.equal(result.receipt, null)
  assert.ok(!result.checks.find((c) => c.id === 'recipient-wallet-not-sanctioned'), 'no sanctions check may appear on the free tier')
  assert.ok(!('proof' in result), 'must never include a proof field')
  assert.ok(!('receipt_id' in result), 'must never include a receipt id')
  assert.ok(!JSON.stringify(result).includes('signature'), 'must never look signed')
}
console.log('ok  free inspect performs no sanctions call, no signing, and returns receipt: null')

// --- transport/service parity: identical deterministic checks -----------

{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const TEST_KEY_ID = 'ed25519-TESTKEYFORINSPECTPARITY'
  const fakeRegistry = [
    { key_id: TEST_KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null },
  ]
  const signReceipt = async (receipt: Receipt): Promise<PublicActionReceiptEnvelope['proof']> => {
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

  const input = baseInput()
  const inspected = await inspectPayment(input)
  const preflighted = await preflightPayment(input, {
    signReceipt,
    fetchKeyRegistry: async () => fakeRegistry,
    storeReceipt: async () => {}, // D2.2: fake — this test stays offline, no real Postgres writes
    mintCapability: async () => ({ token: 'test-capability-token', expiresAt: '2026-01-01T00:00:00.000Z' }),
  })

  assert.deepEqual(inspected.decision, preflighted.decision)
  assert.deepEqual(inspected.checks, preflighted.checks)
}
console.log('ok  inspect_payment and preflight_payment agree exactly on deterministic checks before enrichment')

// --- HTTP: free route works with no payment step -------------------------

{
  const app = new Hono()
  mountInspect(app)

  const ok = await app.request('https://mcp.onchaindiligence.com/inspect/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseInput()),
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('payment-required'), null, 'the free route must never issue a payment challenge')
  const body = (await ok.json()) as any
  assert.equal(body.receipt, null)
  assert.equal(body.evidence.external_checks_performed, false)

  const rejected = await app.request('https://mcp.onchaindiligence.com/inspect/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseInput({ options: { screen_recipient_sanctions: true } })),
  })
  assert.equal(rejected.status, 400)

  const malformed = await app.request('https://mcp.onchaindiligence.com/inspect/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  })
  assert.equal(malformed.status, 400)
}
console.log('ok  POST /inspect/payment returns 200 with no payment step, rejects paid-tier options with 400')

console.log('\nAll D2.1A free inspect_payment tests passed.')
