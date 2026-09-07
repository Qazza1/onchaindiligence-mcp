import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { mountPublicMcp, PUBLIC_TOOL_ANNOTATIONS } from '../src/publicMcp.js'
import { getReceiptById } from '../src/receiptTools.js'

function app() {
  const a = new Hono()
  mountPublicMcp(a, { getReceipt: (id) => getReceiptById(id, { getDurablePublicReceipt: async () => null }) }, () => undefined)
  return a
}
async function rpc(a: Hono, method: string, params: object = {}) {
  const res = await a.request('/public/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.has('payment-required'), false)
  return res.json() as Promise<any>
}
const action = { kind: 'PAYMENT', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '0.001', recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea' }
const receiptId = 'OCD-RCP-EMG6-6KR4-PQSG-MZPQ'

test('initialization and discovery expose only the three intentional free tools', async () => {
  const a = app()
  const init = await rpc(a, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'public-contract-check', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'OnChainDiligence')
  const list = await rpc(a, 'tools/list')
  assert.deepEqual(list.result.tools.map((t: any) => t.name).sort(), Object.keys(PUBLIC_TOOL_ANNOTATIONS).sort())
  for (const t of list.result.tools) assert.deepEqual(t.annotations, PUBLIC_TOOL_ANNOTATIONS[t.name as keyof typeof PUBLIC_TOOL_ANNOTATIONS])
})
test('inspection reuses deterministic evaluator: ALLOW and BLOCK, no receipt or external call', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('No external inspection call permitted') }
  try {
    for (const [max_amount, expected] of [['0.01', 'ALLOW'], ['0.0001', 'BLOCK']]) {
      const result = await rpc(app(), 'tools/call', { name: 'inspect_payment', arguments: { action, policy: { max_amount } } })
      assert.equal(result.result.structuredContent.decision.status, expected)
      assert.equal(result.result.structuredContent.receipt, null)
      assert.equal(result.result.structuredContent.evidence.external_checks_performed, false)
    }
  } finally { globalThis.fetch = oldFetch }
})
test('public receipt retrieval preserves signed envelope and does not enumerate private data', async () => {
  const result = await rpc(app(), 'tools/call', { name: 'get_receipt', arguments: { receipt_id: receiptId } })
  const expected = await getReceiptById(receiptId, { getDurablePublicReceipt: async () => null })
  assert.deepEqual(result.result.structuredContent, expected)
  assert.equal(expected.found, true)
  const unknown = await rpc(app(), 'tools/call', { name: 'get_receipt', arguments: { receipt_id: 'OCD-RCP-AAAA-AAAA-AAAA-AAAA' } })
  assert.deepEqual(unknown.result.structuredContent, { found: false, reason: 'not-found' })
})
test('malformed envelope is INVALID without storage or echo; backend errors are sanitized', async () => {
  const result = await rpc(app(), 'tools/call', { name: 'verify_receipt', arguments: { envelope: { unexpected: 'private-example-marker' } } })
  assert.equal(result.result.structuredContent.state, 'INVALID')
  assert.ok(!JSON.stringify(result).includes('private-example-marker'))
  const a = new Hono()
  mountPublicMcp(a, { verify: async () => { throw new Error('internal-private-error-marker') } }, () => undefined)
  const unavailable = await rpc(a, 'tools/call', { name: 'verify_receipt', arguments: { envelope: {} } })
  assert.equal(unavailable.result.structuredContent.state, 'UNVERIFIABLE')
  assert.ok(!JSON.stringify(unavailable).includes('internal-private-error-marker'))
})
test('paid tools cannot run; request bodies are bounded; existing paid registration is separate', async () => {
  const result = await rpc(app(), 'tools/call', { name: 'preflight_payment', arguments: { action, policy: {} } })
  assert.ok(result.error || result.result?.isError)
  const large = await app().request('/public/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(65537) })
  assert.equal(large.status, 413)
  const entry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  assert.ok(entry.includes("app.all('/mcp'"))
  assert.ok(entry.includes('return handler(c.req.raw)'))
  assert.ok(entry.includes("app.use('/mcp', requireSigningReadiness)"))
})
test('domain challenge is opt-in exact plaintext; submission artifact has exactly five plus three cases', async () => {
  assert.equal((await app().request('/.well-known/openai-apps-challenge')).status, 404)
  const a = new Hono()
  mountPublicMcp(a, {}, () => 'synthetic-local-challenge')
  const response = await a.request('/.well-known/openai-apps-challenge')
  assert.equal(await response.text(), 'synthetic-local-challenge')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const submission = JSON.parse(readFileSync(new URL('../chatgpt-app-submission.json', import.meta.url), 'utf8'))
  assert.equal(submission.test_cases.length, 5)
  assert.equal(submission.negative_test_cases.length, 3)
  assert.equal(submission.schema_version, 1)
  assert.ok(submission.app_info.subtitle.length <= 30)
  assert.deepEqual(Object.keys(submission.tools).sort(), Object.keys(PUBLIC_TOOL_ANNOTATIONS).sort())
  for (const [name, tool] of Object.entries<any>(submission.tools)) assert.deepEqual(tool.annotations, PUBLIC_TOOL_ANNOTATIONS[name as keyof typeof PUBLIC_TOOL_ANNOTATIONS])
})
