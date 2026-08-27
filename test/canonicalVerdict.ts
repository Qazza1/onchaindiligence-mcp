/** Contract test for MCP's canonical API verdict delegation.
 *
 * Run with: npx tsx test/canonicalVerdict.ts
 */

import assert from 'node:assert/strict'

process.env.ATTEST_URL = 'https://canonical.test/attest'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

const requests: Array<{ url: string; init?: RequestInit }> = []
let responseBody: unknown
let responseStatus = 200

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(input), init })
  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

const { canonicalVerdict, canonicalVerdictReady, CanonicalVerdictError } =
  await import('../src/attest.js')

const envelope = {
  data: {
    verdict: 'WARN' as const,
    reasons: ['Direct counterparty exposure could not be evaluated.'],
    address: '0x0000000000000000000000000000000000000001',
    signals: { sanctions: { checked: true, sanctioned: false } },
    verdict_basis: { live_signals: ['sanctions'] },
    checked_at: '2026-01-01T00:00:00.000Z',
  },
  attestation: {
    signed: true,
    algorithm: 'ed25519',
    signature: 'test-signature',
  },
}

responseBody = envelope
const result = await canonicalVerdict(envelope.data.address)
assert.deepStrictEqual(result, envelope, 'MCP must return the API envelope unchanged')
assert.strictEqual(
  requests[0].url,
  `https://canonical.test/internal/verdict/${envelope.data.address}`
)
assert.strictEqual(
  new Headers(requests[0].init?.headers).get('Authorization'),
  `Bearer ${process.env.ATTESTATION_SERVICE_TOKEN}`
)

responseBody = { data: { verdict: 'PASS' }, attestation: { signed: false } }
await assert.rejects(
  () => canonicalVerdict(envelope.data.address),
  (error: unknown) =>
    error instanceof CanonicalVerdictError && /invalid envelope/.test(error.message)
)

responseBody = { ready: true }
assert.strictEqual(await canonicalVerdictReady(), true)
assert.strictEqual(requests[2].url, 'https://canonical.test/internal/verdict/ready')

const { isValidAddressOrEns } = await import('../src/inputValidation.js')
assert.strictEqual(isValidAddressOrEns(envelope.data.address), true)
assert.strictEqual(isValidAddressOrEns('vitalik.eth'), true)
assert.strictEqual(isValidAddressOrEns('not-an-address'), false)

console.log('canonical verdict delegation contract passed')
