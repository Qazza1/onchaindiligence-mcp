/** D4.0 semantic-equivalence gate for the shared payment-policy service. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'

process.env.COMPANIES_HOUSE_API_KEY = 'd40-test-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'd40-test-key-id'
process.env.CDP_API_KEY_SECRET = 'd40-test-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'd40-test-token-not-a-production-secret'

const { Hono } = await import('hono')
const { mountInspect } = await import('../src/inspectRoute.js')
const { mountPublicMcp } = await import('../src/publicMcp.js')
const { createPreflightPostHandler } = await import('../src/discovery.js')
const { inspectPayment } = await import('../src/preflight.js')
const { receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE } = await import('../src/receipts.js')

const input = {
  action: { kind: 'PAYMENT', resource: 'https://merchant.example/pay', network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '0.001', sender: null, recipient: '0x000000000000000000000000000000000000dEaD' },
  policy: { max_amount: '1.00', allowed_networks: ['eip155:8453'], allowed_assets: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'], expected_recipient: null, allowed_resource_origins: ['https://merchant.example'] },
  options: {}, references: {},
}

function project(value: any) {
  const result = value?.structuredContent ?? value
  const receipt = result?.receipt?.receipt ?? result?.receipt ?? null
  const decision = result?.decision ?? receipt?.decision ?? {}
  const checks = result?.checks ?? receipt?.checks ?? []
  return {
    decision: decision.status ?? null,
    reasons: Array.isArray(decision.reasons) ? decision.reasons : checks.map((check: any) => [check.id, check.result]),
    evidence_facts: checks.map((check: any) => ({ id: check.id, result: check.result, evidence_digest: check.evidence_digest ?? null })),
    findings: receipt?.findings?.map((finding: any) => [finding.finding_class, finding.code]) ?? [],
    settlement: receipt?.settlement?.status ?? 'NOT_APPLICABLE',
    binding: receipt?.links?.binding_strength ?? receipt?.binding ?? null,
    limitations: receipt?.limitations ?? [],
  }
}

const core = await inspectPayment(input)
const http = new Hono()
mountInspect(http)
const httpResponse = await http.request('https://mcp.onchaindiligence.com/inspect/payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
assert.equal(httpResponse.status, 200)
const viaHttp = await httpResponse.json()

const mcp = new Hono()
mountPublicMcp(mcp)
const mcpResponse = await mcp.request('/public/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_payment', arguments: input } }) })
assert.equal(mcpResponse.status, 200)
const viaMcp = await mcpResponse.json() as any

assert.deepEqual(project(viaHttp), project(core), 'HTTP inspection semantic projection must match core')
assert.deepEqual(project(viaMcp.result), project(core), 'MCP inspection semantic projection must match core')

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keyId = 'ed25519-D40TRUSTINVARIANT'
const registry = [{ key_id: keyId, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null }]
const x402 = new Hono()
x402.post('/x402/preflight-payment', createPreflightPostHandler({
  signReceipt: async (receipt) => {
    const issued_at = '2026-01-01T00:00:00.000Z'
    const signature = ed25519Sign(null, Buffer.from(receiptAttestationSigningInput(receipt, { issuer: PUBLIC_ACTION_RECEIPT_ISSUER, purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issuedAt: issued_at, keyId })), privateKey).toString('base64url')
    return { signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: PUBLIC_ACTION_RECEIPT_ISSUER, purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issued_at, key_id: keyId, algorithm: 'ed25519', canonicalization: 'RFC8785', signature }
  },
  fetchKeyRegistry: async () => registry,
  storeReceipt: async () => {},
  mintCapability: async () => ({ token: 'test', expiresAt: '2026-01-01T00:00:00.000Z' }),
}))
const x402Response = await x402.request('https://mcp.onchaindiligence.com/x402/preflight-payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
assert.equal(x402Response.status, 200)
const viaX402 = await x402Response.json()
const x402Projection = project(viaX402)
const coreProjection = project(core)
assert.equal(x402Projection.decision, coreProjection.decision)
assert.deepEqual(x402Projection.reasons, coreProjection.reasons)
assert.deepEqual(x402Projection.evidence_facts, coreProjection.evidence_facts)
assert.deepEqual(x402Projection.findings, coreProjection.findings)
assert.equal(x402Projection.settlement, coreProjection.settlement)
assert.equal(x402Projection.binding, coreProjection.binding)
assert.ok(x402Projection.limitations.length > 0, 'x402 paid preflight must retain signed limitations')

console.log('ok  HTTP, x402, and MCP routes preserve the canonical policy semantic projection; x402 adds only a signed receipt wrapper')
