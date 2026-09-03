/** D1.1 contract tests for the standard HTTP x402 surface.
 *
 * Run with: npx tsx test/x402Routes.ts
 *
 * Covers: route definitions, prices against canonical config, network, payTo,
 * Bazaar extension presence, pre-payment input rejection, OpenAPI validity,
 * the well-known manifest, that no paid resource executes for free, and that
 * telemetry cannot emit caller input.
 *
 * Fully offline: the facilitator, Companies House, OFAC, EDGAR and the
 * attestation service are never contacted. Any outbound fetch fails the test.
 */

import assert from 'node:assert/strict'

// Config the modules require at import time. These are test values only.
process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

// Any network call during these tests is a bug: assert offline behaviour.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

/**
 * Mounting the payment middleware makes it lazily initialise the CDP
 * facilitator. With the placeholder credentials above that initialisation
 * fails asynchronously, which is expected and unrelated to what this file
 * asserts (route configuration, pre-payment guards, discovery documents,
 * telemetry). Swallow ONLY that exact failure — anything else still crashes
 * the run, so a real unhandled rejection is never hidden.
 */
process.on('unhandledRejection', (error: unknown) => {
  const message = String((error as Error)?.message ?? error)
  if (message.includes('no supported payment kinds loaded from any facilitator')) return
  throw error
})

const { Hono } = await import('hono')
const { config } = await import('../src/config.js')
const { mountDiscovery, CAIP2, usd, X402_ROUTES } = await import('../src/discovery.js')
const { buildOpenApiDocument, buildWellKnownManifest, mountPublicMetadata } = await import(
  '../src/publicMetadata.js'
)
const { recordEvent, outcomeForStatus, readMcpEnvelope } = await import('../src/telemetry.js')

// --- 1. Every capability has a route, and the payment middleware knows it ---

const app = new Hono()
mountDiscovery(app)
mountPublicMetadata(app)

const PAID_ROUTES: Array<{ key: string; priceUsd: number }> = [
  { key: 'GET /x402/screen/:address', priceUsd: config.prices.screen },
  { key: 'GET /x402/screen-name', priceUsd: config.prices.nameScreen },
  { key: 'GET /x402/uk-company/:companyNumber', priceUsd: config.prices.company },
  { key: 'GET /x402/us-company', priceUsd: config.prices.usCompany },
  { key: 'GET /x402/diligence', priceUsd: config.prices.diligence },
  { key: 'GET /x402/verdict/:address', priceUsd: config.prices.screen },
  { key: 'POST /x402/preflight-payment', priceUsd: config.prices.preflight },
]

// The declared route map is what the payment middleware charges on. Asserting
// it directly keeps this test offline: constructing the live middleware would
// require real CDP facilitator credentials.
const declared = Object.keys(X402_ROUTES as Record<string, unknown>)
assert.equal(
  declared.length,
  PAID_ROUTES.length,
  `expected ${PAID_ROUTES.length} paid routes, found ${declared.length}: ${declared.join(', ')}`
)

for (const route of PAID_ROUTES) {
  const entry = (X402_ROUTES as Record<string, any>)[route.key]
  assert.ok(entry, `missing paid route: ${route.key}`)

  assert.equal(entry.accepts.scheme, 'exact', `${route.key} scheme`)
  assert.equal(entry.accepts.network, CAIP2, `${route.key} network`)
  assert.equal(
    String(entry.accepts.payTo).toLowerCase(),
    config.x402.recipient.toLowerCase(),
    `${route.key} must pay the configured OCD recipient`
  )
  assert.equal(
    entry.accepts.price,
    usd(route.priceUsd),
    `${route.key} price must match canonical config.prices`
  )
  assert.equal(entry.mimeType, 'application/json', `${route.key} mimeType`)

  // Bazaar discovery metadata must be present, or CDP will never index it.
  assert.ok(entry.extensions?.bazaar, `${route.key} must declare the Bazaar extension`)
  // Every route's example must show its signed cryptographic proof, either
  // the standard {data, attestation} envelope or (Payment Preflight only)
  // the receipt envelope's nested receipt.proof.
  const example = entry.extensions.bazaar.info?.output?.example
  assert.ok(
    example?.attestation || example?.receipt?.proof,
    `${route.key} Bazaar example must show a signed proof (attestation or receipt.proof)`
  )
  assert.ok(
    typeof entry.description === 'string' && entry.description.length > 80,
    `${route.key} needs a real capability description`
  )
}
console.log(`ok  ${PAID_ROUTES.length} paid routes: price/network/payTo/mimeType + Bazaar metadata`)

// Descriptions must let a buyer tell the capabilities apart, and must not
// overclaim. Diligence in particular must disclaim the wallet<->company link.
const diligenceDescription = (X402_ROUTES as Record<string, any>)['GET /x402/diligence'].description
assert.ok(
  /does NOT establish that\s+the wallet belongs to/i.test(diligenceDescription.replace(/\s+/g, ' ')) ||
    /NOT establish/i.test(diligenceDescription),
  'diligence must state it does not link the wallet to the company'
)
const nameDescription = (X402_ROUTES as Record<string, any>)['GET /x402/screen-name'].description
assert.ok(/not a determination/i.test(nameDescription), 'name screening must not claim a determination')
assert.ok(/screens names, not wallet/i.test(nameDescription), 'must distinguish from wallet screening')
const descriptions = PAID_ROUTES.map((r) => (X402_ROUTES as Record<string, any>)[r.key].description)
assert.equal(new Set(descriptions).size, descriptions.length, 'each capability needs a distinct description')
console.log('ok  descriptions distinguish capabilities and disclaim what they do not prove')

// --- 2. Prices are defined once, and the helper formats USD exactly ---------

assert.equal(usd(0.01), '$0.01')
assert.equal(usd(0.02), '$0.02')
assert.equal(usd(0.05), '$0.05')
assert.equal(usd(0.1), '$0.10', 'must not render as $0.1')
console.log('ok  usd() formats canonical prices exactly')

// --- 3. Invalid input is rejected BEFORE any payment challenge -------------

const PRE_PAYMENT_REJECTIONS = [
  '/x402/screen-name',
  '/x402/screen-name?name=x',
  '/x402/uk-company/not-a-company-number',
  '/x402/diligence?company=00000006',
  '/x402/diligence?wallet=notanaddress&company=00000006',
  '/x402/diligence?wallet=0x0000000000000000000000000000000000000000&company=%2Fetc%2Fpasswd',
  '/x402/verdict/notanaddress',
]
for (const path of PRE_PAYMENT_REJECTIONS) {
  const res = await app.request(path)
  assert.equal(res.status, 400, `${path} must be rejected pre-payment, got ${res.status}`)
  assert.equal(
    res.headers.get('payment-required'),
    null,
    `${path} must not issue a payment challenge for invalid input`
  )
}
console.log(`ok  ${PRE_PAYMENT_REJECTIONS.length} invalid inputs rejected before any payment challenge`)

// Payment Preflight takes a JSON body rather than path/query params, so it
// gets its own POST-shaped pre-payment rejection cases.
const PREFLIGHT_PRE_PAYMENT_REJECTIONS: Array<Record<string, unknown>> = [
  {},
  { action: { kind: 'PAYMENT' } },
  {
    action: {
      kind: 'PAYMENT',
      resource: null,
      network: 'not-caip2',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1.00',
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
    },
    policy: { max_amount: null, allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null },
  },
  {
    action: {
      kind: 'PAYMENT',
      resource: null,
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1.5e2',
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
    },
    policy: { max_amount: null, allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null },
  },
]
for (const body of PREFLIGHT_PRE_PAYMENT_REJECTIONS) {
  const res = await app.request('/x402/preflight-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 400, `preflight-payment must reject ${JSON.stringify(body)} pre-payment, got ${res.status}`)
  assert.equal(res.headers.get('payment-required'), null, 'must not issue a payment challenge for invalid preflight input')
}
console.log(
  `ok  ${PREFLIGHT_PRE_PAYMENT_REJECTIONS.length} invalid preflight bodies rejected before any payment challenge`
)

// --- 4. Free discovery documents are genuinely free -------------------------

const openApiRes = await app.request('/openapi.json')
assert.equal(openApiRes.status, 200, '/openapi.json must be free')
const openapi = (await openApiRes.json()) as any
assert.equal(openapi.openapi, '3.1.0')
assert.ok(openapi.info?.title && openapi.servers?.[0]?.url)

// Every paid route appears, documents its 402, and returns the signed envelope.
const documented = Object.keys(openapi.paths)
for (const expected of [
  '/x402/screen/{address}',
  '/x402/screen-name',
  '/x402/uk-company/{companyNumber}',
  '/x402/us-company',
  '/x402/diligence',
  '/x402/verdict/{address}',
]) {
  assert.ok(documented.includes(expected), `OpenAPI must document ${expected}`)
  const op = openapi.paths[expected].get
  assert.ok(op.responses['402'], `${expected} must document its 402 behaviour`)
  assert.ok(op.responses['400'], `${expected} must document pre-payment rejection`)
  const envelope = op.responses['200'].content['application/json'].schema
  assert.deepEqual(envelope.required, ['data', 'attestation'], `${expected} signed envelope`)
  // Vendor extension must be namespaced to us, never a fake x402 standard field.
  assert.ok(op['x-onchaindiligence-x402'], `${expected} vendor block`)
  assert.equal(op['x-onchaindiligence-x402'].network, CAIP2)
  assert.equal(
    op['x-onchaindiligence-x402'].payTo.toLowerCase(),
    config.x402.recipient.toLowerCase()
  )
}
assert.equal(
  JSON.stringify(openapi).includes('"x-402"'),
  false,
  'must not invent an official-looking x402 OpenAPI extension'
)
// OpenAPI describes the paid HTTP surface, not the MCP JSON-RPC transport.
assert.ok(!documented.includes('/mcp'), 'OpenAPI must not document the MCP transport as a path')

// Payment Preflight is POST with a request body and a different response
// shape (decision/checks/receipt, not {data, attestation}) — its own block.
assert.ok(documented.includes('/x402/preflight-payment'), 'OpenAPI must document /x402/preflight-payment')
const preflightOp = openapi.paths['/x402/preflight-payment'].post
assert.ok(preflightOp, '/x402/preflight-payment must be documented under POST, not GET')
assert.ok(preflightOp.responses['402'], 'preflight-payment must document its 402 behaviour')
assert.ok(preflightOp.responses['400'], 'preflight-payment must document pre-payment rejection')
assert.ok(preflightOp.requestBody?.content['application/json']?.schema, 'preflight-payment must document its request body')
const preflightEnvelope = preflightOp.responses['200'].content['application/json'].schema
assert.deepEqual(preflightEnvelope.required, ['decision', 'checks', 'receipt'], 'preflight-payment response shape')
assert.equal(preflightOp['x-onchaindiligence-x402'].network, CAIP2)
assert.equal(preflightOp['x-onchaindiligence-x402'].priceUsd, config.prices.preflight)
assert.ok(
  /does not authorize or submit the payment/i.test(preflightOp.description),
  'preflight-payment description must explicitly disclaim executing/authorizing the payment'
)
// D2.1A: the free inspection primitive is documented, but clearly
// distinguished from the paid preflight — no 402, no payment vendor block,
// and its own decision/checks/evidence/receipt shape with receipt always null.
assert.ok(documented.includes('/inspect/payment'), 'OpenAPI must document the free /inspect/payment resource')
const inspectOp = openapi.paths['/inspect/payment'].post
assert.ok(inspectOp, '/inspect/payment must be documented under POST')
assert.ok(!inspectOp.responses['402'], '/inspect/payment must never document a 402 — it is free')
assert.ok(!inspectOp['x-onchaindiligence-x402'], '/inspect/payment must not carry the paid x402 vendor block')
assert.ok(/FREE/.test(inspectOp.description), '/inspect/payment description must say it is free')
const inspectEnvelope = inspectOp.responses['200'].content['application/json'].schema
assert.deepEqual(inspectEnvelope.required, ['decision', 'checks', 'evidence', 'receipt'], '/inspect/payment response shape')
assert.equal(inspectEnvelope.properties.receipt.type, 'null', '/inspect/payment must declare receipt as always null')

// documented.length = every paid route (PAID_ROUTES) + the one free resource.
assert.equal(documented.length, PAID_ROUTES.length + 1, `expected ${PAID_ROUTES.length + 1} documented resources (paid + 1 free)`)
console.log(`ok  /openapi.json is free, valid 3.1, documents ${documented.length} resources (${PAID_ROUTES.length} paid + 1 free, clearly distinguished)`)

const manifestRes = await app.request('/.well-known/x402')
assert.equal(manifestRes.status, 200, '/.well-known/x402 must be free')
const manifest = (await manifestRes.json()) as any
assert.equal(manifest.x402Version, 2)
assert.equal(manifest.kind, 'resource-server')
assert.equal(manifest.resources.length, PAID_ROUTES.length)
for (const entry of manifest.resources) {
  assert.ok(entry.url.startsWith('https://mcp.onchaindiligence.com/x402/'), 'https, own domain')
  assert.ok(entry.method && entry.description, 'each resource needs method + description')
}
// The x402 capability manifest is specifically about PAYABLE resources — the
// free D2.1A inspection primitive must never appear in it.
assert.ok(
  !manifest.resources.some((r: any) => r.url.includes('/inspect/payment')),
  'the free /inspect/payment resource must never appear in the x402 payment manifest'
)
console.log('ok  /.well-known/x402 manifest present, one canonical path, own-domain https resources, excludes the free resource')

// --- 5. Telemetry cannot emit caller input ---------------------------------

const logged: string[] = []
const realLog = console.log
console.log = (line?: any) => {
  logged.push(String(line))
}
recordEvent('http.request', {
  route: '/x402/uk-company/:companyNumber',
  status: 402,
  outcome: 'challenge',
  // Everything below is NOT in the allowlist and must be dropped.
  ...({
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    name: 'A Screened Person',
    company: '00000006',
    'x-payment': 'secret-payment-header',
    query: '?name=A%20Screened%20Person',
  } as any),
})
console.log = realLog

assert.equal(logged.length, 1)
const emitted = logged[0]
for (const forbidden of [
  '0xdeadbeef',
  'A Screened Person',
  '00000006',
  'secret-payment-header',
  '?name=',
]) {
  assert.ok(!emitted.includes(forbidden), `telemetry leaked ${forbidden}`)
}
assert.ok(emitted.startsWith('x402_funnel '), 'stable log prefix for aggregation')
const parsed = JSON.parse(emitted.slice('x402_funnel '.length))
assert.deepEqual(Object.keys(parsed).sort(), ['event', 'outcome', 'route', 'status'])
assert.equal(parsed.route, '/x402/uk-company/:companyNumber', 'route template, not concrete path')
console.log('ok  telemetry emits only allowlisted aggregate fields')

assert.equal(outcomeForStatus(402), 'challenge')
assert.equal(outcomeForStatus(200), 'ok')
assert.equal(outcomeForStatus(400), 'rejected')
assert.equal(outcomeForStatus(502), 'error')

// MCP envelope reader takes the method and static tool name, nothing else.
assert.deepEqual(
  readMcpEnvelope(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'screen_wallet', arguments: { address: '0xsecret' } },
    })
  ),
  { method: 'tools/call', tool: 'screen_wallet' }
)
assert.deepEqual(readMcpEnvelope('not json'), {})
assert.deepEqual(readMcpEnvelope(JSON.stringify({ method: 'tools/list' })), {
  method: 'tools/list',
})
console.log('ok  MCP envelope reader extracts method/tool only, never arguments')

console.log('\nAll D1.1 x402 route contract tests passed.')
