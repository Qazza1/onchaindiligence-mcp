/** D2.1 focused tests for Payment Preflight v1.
 *
 * Run with: npx tsx test/preflight.ts
 *
 * Fully offline: signing and the attestation key registry are both replaced
 * with a freshly-generated local keypair via PreflightDependencies — the
 * exact same seam preflightPayment() exposes for this reason. No network
 * call, no live /attest, no real money. The Chainalysis oracle is likewise
 * replaced with an injected fake for the sanctions-path tests.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import type { PreflightInput } from '../src/preflight.js'
import type { Receipt, PublicActionReceiptEnvelope } from '../src/receipts.js'

// Config the modules require at import time. Test values only — see
// test/x402Routes.ts, which establishes this same pattern.
process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

// Every fetch below is replaced by an injected PreflightDependencies fake
// (signing, key registry, sanctions screening); a real network call here
// would be a bug in the test, not expected behaviour.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

// Mounting the payment middleware (pulled in transitively via discovery.ts)
// lazily initialises the CDP facilitator; with placeholder credentials that
// fails asynchronously off the main path. Expected and unrelated to what
// this file asserts — see the identical comment in test/x402Routes.ts.
process.on('unhandledRejection', (error: unknown) => {
  const message = String((error as Error)?.message ?? error)
  if (message.includes('no supported payment kinds loaded from any facilitator')) return
  throw error
})

const { Hono } = await import('hono')
const {
  evaluatePreflightPolicy,
  parsePreflightInput,
  preflightPayment,
  PreflightInputError,
} = await import('../src/preflight.js')
const { createPreflightPostHandler } = await import('../src/discovery.js')
const {
  receiptAttestationSigningInput,
  PUBLIC_ACTION_RECEIPT_ISSUER,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
} = await import('../src/receipts.js')

// --- a throwaway local signer + registry, standing in for the real /attest
// network call and the real https://api.onchaindiligence.com/.well-known/attestation-keys ---
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const TEST_KEY_ID = 'ed25519-TESTKEYFORPREFLIGHT'
const fakeRegistry = [
  { key_id: TEST_KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null },
]
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
    signature,
  }
}
// D2.2 introduced durable storage + finalization capability minting as part
// of a successful preflightPayment(). Fake both here so this suite stays
// fully offline (no real Postgres writes from a unit test) — real storage
// wiring is covered by test/finalize.ts against an injectable store.
const fakeStoreReceipt = async () => {}
const fakeMintCapability = async () => ({ token: 'test-capability-token', expiresAt: '2026-01-01T00:00:00.000Z' })
const testDeps = {
  signReceipt: fakeSignReceipt,
  fetchKeyRegistry: async () => fakeRegistry,
  storeReceipt: fakeStoreReceipt,
  mintCapability: fakeMintCapability,
}

function baseInput(overrides: Partial<PreflightInput['action']> = {}): unknown {
  return {
    action: {
      kind: 'PAYMENT',
      resource: 'https://service.example/api',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1.00',
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
      ...overrides,
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

// --- input parsing -----------------------------------------------------

assert.throws(() => parsePreflightInput(null), PreflightInputError)
assert.throws(() => parsePreflightInput({}), PreflightInputError)
assert.throws(() => parsePreflightInput(baseInput({ kind: 'REFUND' as any })), /action\.kind/)
assert.throws(() => parsePreflightInput(baseInput({ network: 'base' })), /CAIP-2/)
assert.throws(() => parsePreflightInput(baseInput({ amount: '1.5e2' })), /canonical decimal/)
assert.throws(() => parsePreflightInput(baseInput({ amount: '01.50' })), /canonical decimal/)
assert.throws(() => parsePreflightInput(baseInput({ amount: 1.5 as any })), /action\.amount/)
assert.throws(() => parsePreflightInput(baseInput({ recipient: 'not-an-address' })), /EVM address/)
assert.doesNotThrow(() => parsePreflightInput(baseInput()))
console.log('ok  input parsing rejects malformed input before any network call')

// --- deterministic decision rules --------------------------------------

{
  const { decision } = await evaluatePreflightPolicy(parsePreflightInput(baseInput({ amount: '4.99' })))
  assert.equal(decision.status, 'ALLOW')
  assert.equal(decision.authorized, true)
}
{
  const { decision } = await evaluatePreflightPolicy(parsePreflightInput(baseInput({ amount: '5.00' })))
  assert.equal(decision.status, 'ALLOW', 'amount equal to max_amount must ALLOW, not BLOCK')
}
{
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(baseInput({ amount: '5.01' })))
  assert.equal(decision.status, 'BLOCK')
  assert.equal(decision.authorized, false)
  assert.ok(checks.find((c) => c.id === 'amount-within-max' && c.result === 'FAIL'))
}
console.log('ok  amount below/equal/above max_amount: ALLOW/ALLOW/BLOCK')

{
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(baseInput({ network: 'eip155:1' })))
  assert.equal(decision.status, 'BLOCK')
  assert.ok(checks.find((c) => c.id === 'network-allowed' && c.result === 'FAIL'))
}
console.log('ok  network not on allowlist -> BLOCK')

{
  const { decision, checks } = await evaluatePreflightPolicy(
    parsePreflightInput(baseInput({ asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }))
  )
  assert.equal(decision.status, 'BLOCK')
  assert.ok(checks.find((c) => c.id === 'asset-allowed' && c.result === 'FAIL'))
}
console.log('ok  asset not on allowlist -> BLOCK')

{
  const input = parsePreflightInput(baseInput())
  input.policy.expected_recipient = '0x1111111111111111111111111111111111111111'
  const { decision, checks } = await evaluatePreflightPolicy(input)
  assert.equal(decision.status, 'BLOCK')
  assert.ok(checks.find((c) => c.id === 'recipient-matches-expected' && c.result === 'FAIL'))
}
console.log('ok  expected recipient mismatch -> BLOCK')

{
  const raw = baseInput() as any
  raw.action.resource = 'https://not-allowed.example/api'
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(raw))
  assert.equal(decision.status, 'BLOCK')
  assert.ok(checks.find((c) => c.id === 'resource-origin-allowed' && c.result === 'FAIL'))
}
console.log('ok  resource origin not on allowlist -> BLOCK')

{
  // Origin restriction configured but no resource URL to check it against ->
  // insufficient evidence, not a silent pass and not a hard violation.
  const raw = baseInput() as any
  raw.action.resource = null
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(raw))
  assert.equal(decision.status, 'REQUIRE_APPROVAL')
  assert.ok(checks.find((c) => c.id === 'resource-origin-allowed' && c.result === 'UNKNOWN'))
}
console.log('ok  origin policy configured but resource missing -> REQUIRE_APPROVAL, never a silent PASS')

{
  const raw = baseInput() as any
  raw.options = { screen_recipient_sanctions: true }
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(raw), {
    screenRecipient: async () => ({ address: raw.action.recipient, sanctioned: true, identifications: [] }),
  })
  assert.equal(decision.status, 'BLOCK')
  const check = checks.find((c) => c.id === 'recipient-wallet-not-sanctioned')
  assert.equal(check?.result, 'FAIL')
}
console.log('ok  sanctioned recipient -> BLOCK')

{
  const raw = baseInput() as any
  raw.options = { screen_recipient_sanctions: true }
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(raw), {
    screenRecipient: async () => {
      throw new Error('oracle RPC unreachable')
    },
  })
  assert.equal(decision.status, 'REQUIRE_APPROVAL')
  const check = checks.find((c) => c.id === 'recipient-wallet-not-sanctioned')
  assert.equal(check?.result, 'UNKNOWN')
  assert.ok(!/\bis safe\b|\bsafe wallet\b/i.test(check!.summary), 'must never word an unreachable oracle as a positive safety claim')
}
console.log('ok  sanctions oracle unavailable -> REQUIRE_APPROVAL, never worded as "safe"')

{
  const raw = baseInput() as any
  raw.options = { screen_recipient_sanctions: true }
  const { decision, checks } = await evaluatePreflightPolicy(parsePreflightInput(raw), {
    screenRecipient: async () => ({ address: raw.action.recipient, sanctioned: false, identifications: [] }),
  })
  assert.equal(decision.status, 'ALLOW')
  const check = checks.find((c) => c.id === 'recipient-wallet-not-sanctioned')
  assert.equal(check?.result, 'PASS')
  assert.ok(!/is safe/i.test(check!.summary), 'a clean sanctions result must not be worded as a general safety claim')
}
console.log('ok  all configured checks pass, including sanctions screen -> ALLOW')

// --- private policy values never leak into public check summaries -------

{
  const { checks } = await evaluatePreflightPolicy(parsePreflightInput(baseInput({ amount: '5.01' })))
  const blob = JSON.stringify(checks)
  assert.ok(!blob.includes('5.00'), 'the configured max_amount value must not appear in public check text')
}
console.log('ok  configured policy threshold value does not leak into public check summaries')

// --- mandate digest is referenced, never leaked as content --------------

{
  const raw = baseInput() as any
  raw.references = { mandate_digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  const { checks } = await evaluatePreflightPolicy(parsePreflightInput(raw))
  const check = checks.find((c) => c.id === 'mandate-digest-referenced')
  assert.equal(check?.result, 'NOT_CHECKED')
  assert.equal(check?.evidence_digest, raw.references.mandate_digest)
}
console.log('ok  mandate_digest is referenced by digest only, and never affects the decision')

// --- full signed receipt: PREFLIGHT / NOT_SUBMITTED / NOT_APPLICABLE / VALID ---

{
  const result = await preflightPayment(baseInput({ amount: '4.99' }), testDeps)
  assert.equal(result.receipt.receipt.receipt_type, 'PREFLIGHT')
  assert.equal(result.receipt.receipt.execution.status, 'NOT_SUBMITTED')
  assert.equal(result.receipt.receipt.execution.transaction_hash, null)
  assert.equal(result.receipt.receipt.settlement.status, 'NOT_APPLICABLE')
  assert.equal(result.decision.status, 'ALLOW')
  assert.equal(result.decision.authorized, true)
  // decision/checks on the outer result must be read from the finalized
  // receipt itself, never a second independently-computed copy.
  assert.equal(result.decision, result.receipt.receipt.decision)
  assert.equal(result.checks, result.receipt.receipt.checks)
  assert.ok(result.receipt.receipt.limitations.length > 0)
  assert.equal(result.receipt.receipt.links.agent_evidence_bundle_digest, null)

  // D2.2: a finalization capability is minted, and it is never part of the
  // (public) receipt envelope.
  assert.equal(result.finalization.capability, 'test-capability-token')
  assert.equal(result.finalization.expires_at, '2026-01-01T00:00:00.000Z')
  assert.equal(result.finalization.endpoint, 'https://mcp.onchaindiligence.com/receipts/finalize')
  assert.ok(!JSON.stringify(result.receipt).includes('test-capability-token'), 'the capability must never appear inside the receipt envelope')

  const { verifyReceiptEnvelope } = await import('../src/receipts.js')
  const verification = verifyReceiptEnvelope(result.receipt, fakeRegistry)
  assert.equal(verification.state, 'VALID')
}
console.log('ok  PREFLIGHT receipt: NOT_SUBMITTED / NOT_APPLICABLE / proof VALID')

{
  // A receipt whose proof does not verify VALID must never be returned as a
  // successful result — preflightPayment must fail closed.
  await assert.rejects(
    () => preflightPayment(baseInput(), { signReceipt: fakeSignReceipt, fetchKeyRegistry: async () => [] }),
    /did not verify VALID/
  )
}
console.log('ok  preflightPayment fails closed if the receipt cannot be verified VALID')

// --- transport parity: HTTP adapter vs. the core service ----------------

{
  const input = baseInput({ amount: '4.99' })
  const direct = await preflightPayment(input, testDeps)

  const app = new Hono()
  app.post('/x402/preflight-payment', createPreflightPostHandler(testDeps))
  const res = await app.request('https://mcp.onchaindiligence.com/x402/preflight-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  assert.equal(res.status, 200)
  const viaHttp = (await res.json()) as typeof direct

  assert.deepEqual(viaHttp.decision, direct.decision)
  assert.deepEqual(viaHttp.checks, direct.checks)
  assert.equal(viaHttp.receipt.receipt.receipt_type, direct.receipt.receipt.receipt_type)
  assert.equal(viaHttp.receipt.receipt.action.amount, direct.receipt.receipt.action.amount)
  // MCP calls the identical preflightPayment() import (src/server.ts) — there
  // is no separate policy implementation to test for parity against; this is
  // enforced by having exactly one service function, not by a second engine.
}
console.log('ok  HTTP adapter and the core service produce equivalent decision/check semantics')

// --- HTTP pre-payment rejection: malformed input never reaches evaluation ---

{
  const app = new Hono()
  app.use('/x402/preflight-payment', async (c, next) => {
    let body: unknown
    try {
      body = await c.req.raw.clone().json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    try {
      parsePreflightInput(body)
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
    await next()
  })
  app.post('/x402/preflight-payment', createPreflightPostHandler(testDeps))

  const res = await app.request('https://mcp.onchaindiligence.com/x402/preflight-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: { kind: 'PAYMENT' } }),
  })
  assert.equal(res.status, 400)
}
console.log('ok  malformed preflight body rejected with 400 before evaluation')

console.log('\nAll D2.1 Payment Preflight tests passed.')
