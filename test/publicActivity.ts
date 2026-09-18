/** Focused tests for GET /public/activity. Run with: npx tsx test/publicActivity.ts (offline; loader injected). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { UsageActivityRows } from '../src/db.js'
import { mountPublicActivity, classifyClient, ACTIVITY_ALLOWED_ORIGIN } from '../src/activity.js'

delete process.env.DATABASE_URL

const EMPTY: UsageActivityRows = {
  telemetrySince: null,
  totals: { sessions: 0, public_sessions: 0, paid_sessions: 0, initialized: 0, tools_listed: 0, tool_calls: 0, successful_tool_calls: 0, failed_tool_calls: 0, x402_challenges: 0, receipts: 0 },
  clients: [],
  timeline: [],
  recent: [],
}

const MALICIOUS_NAMES = [
  '<script>alert(1)</script>',
  "'; DROP TABLE usage_events; --",
  'wellknown-prober (your listing: https://evil.example/claim — claim it at https://evil.example/claim)',
  'x'.repeat(10_000),
]

const POPULATED: UsageActivityRows = {
  telemetrySince: '2026-09-18T09:05:35.438Z',
  totals: { sessions: 12, public_sessions: 3, paid_sessions: 9, initialized: 14, tools_listed: 11, tool_calls: 5, successful_tool_calls: 2, failed_tool_calls: 1, x402_challenges: 7, receipts: 1 },
  clients: [
    { client_name: 'codex-mcp-client', sessions: 3 },
    { client_name: 'GLAMA', sessions: 2 },
    { client_name: 'brand-new-probe', sessions: 1 },
    ...MALICIOUS_NAMES.map((client_name) => ({ client_name, sessions: 1 })),
    { client_name: null, sessions: 1 },
  ],
  timeline: [{ bucket: '2026-09-18T10:00:00.000Z', sessions: 12, tool_calls: 5, successful_tool_calls: 2, x402_challenges: 7 }],
  recent: [
    { occurred_at: '2026-09-18T10:05:00.000Z', event: 'mcp.session', surface: 'public', method: null, tool: null, outcome: null, status: null, client_name: MALICIOUS_NAMES[0] },
    { occurred_at: '2026-09-18T10:04:00.000Z', event: 'mcp.request', surface: 'paid', method: 'tools/call', tool: '<img src=x onerror=alert(1)>', outcome: null, status: null, client_name: null },
    { occurred_at: '2026-09-18T10:03:00.000Z', event: 'mcp.request', surface: 'paid', method: 'tools/call', tool: 'screen_wallet', outcome: null, status: null, client_name: null },
    { occurred_at: '2026-09-18T10:02:00.000Z', event: 'mcp.tool_result', surface: 'paid', method: null, tool: 'verify_receipt', outcome: 'error', status: null, client_name: null },
    { occurred_at: '2026-09-18T10:01:30.000Z', event: 'mcp.tool_result', surface: 'public', method: null, tool: 'inspect_payment', outcome: 'ok', status: null, client_name: null },
    { occurred_at: '2026-09-18T10:01:00.000Z', event: 'http.request', surface: null, method: null, tool: null, outcome: 'challenge', status: '402', client_name: null },
    { occurred_at: '2026-09-18T10:00:30.000Z', event: 'http.request', surface: null, method: null, tool: null, outcome: 'rejected', status: '400', client_name: null },
    { occurred_at: '2026-09-18T10:00:20.000Z', event: 'receipt.created', surface: null, method: null, tool: null, outcome: null, status: null, client_name: null },
    { occurred_at: '2026-09-18T10:00:10.000Z', event: 'mcp.request', surface: 'public', method: 'tools/list', tool: null, outcome: null, status: null, client_name: null },
    { occurred_at: '2026-09-18T10:00:00.000Z', event: 'something.unexpected', surface: 'paid', method: null, tool: null, outcome: null, status: null, client_name: null },
  ],
}

function appWith(load: (interval: string, stride: string) => Promise<UsageActivityRows>) {
  const app = new Hono()
  mountPublicActivity(app, { load, now: () => new Date('2026-09-18T10:10:00.000Z') })
  return app
}

test('window allowlist: 1h/24h/7d accepted, default 24h, only allowlisted intervals reach SQL', async () => {
  const seen: Array<[string, string]> = []
  const app = appWith(async (interval, stride) => { seen.push([interval, stride]); return EMPTY })
  for (const [query, expected] of [['?window=1h', '1h'], ['?window=24h', '24h'], ['?window=7d', '7d'], ['', '24h']] as const) {
    const res = await app.request(`/public/activity${query}`)
    assert.equal(res.status, 200)
    assert.equal((await res.json() as any).window, expected)
  }
  assert.deepEqual(seen, [['1 hour', '5 minutes'], ['24 hours', '1 hour'], ['7 days', '6 hours'], ['24 hours', '1 hour']])
})

test('invalid windows are rejected with 400 before any database read', async () => {
  let calls = 0
  const app = appWith(async () => { calls++; return EMPTY })
  for (const bad of ['2h', '7D', '', '__proto__', 'toString', "24h'; DROP TABLE usage_events; --", '1 hour']) {
    const res = await app.request(`/public/activity?window=${encodeURIComponent(bad)}`)
    assert.equal(res.status, 400, `window=${bad}`)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  }
  assert.equal(calls, 0)
})

test('zero-data response reports true zeros, empty lists, and null for unmeasured payments', async () => {
  const body = await (await appWith(async () => EMPTY).request('/public/activity')).json() as any
  assert.equal(body.telemetry_since, null)
  assert.deepEqual(body.totals, { sessions: 0, public_sessions: 0, paid_sessions: 0, tool_calls: 0, successful_tool_calls: 0, failed_tool_calls: 0, x402_challenges: 0, completed_paid_executions: null, receipts: 0 })
  assert.deepEqual(body.funnel, { initialized: 0, tools_listed: 0, tools_called: 0, tool_results_ok: 0, payments_completed: null, receipts_created: 0 })
  assert.deepEqual(body.clients, [])
  assert.deepEqual(body.timeline, [])
  assert.deepEqual(body.recent_activity, [])
})

test('aggregate counts and funnel mirror the loaded totals exactly', async () => {
  const body = await (await appWith(async () => POPULATED).request('/public/activity')).json() as any
  assert.equal(body.generated_at, '2026-09-18T10:10:00.000Z')
  assert.equal(body.telemetry_since, '2026-09-18T09:05:35.438Z')
  assert.deepEqual(body.totals, { sessions: 12, public_sessions: 3, paid_sessions: 9, tool_calls: 5, successful_tool_calls: 2, failed_tool_calls: 1, x402_challenges: 7, completed_paid_executions: null, receipts: 1 })
  assert.deepEqual(body.funnel, { initialized: 14, tools_listed: 11, tools_called: 5, tool_results_ok: 2, payments_completed: null, receipts_created: 1 })
  assert.deepEqual(body.timeline, POPULATED.timeline)
})

test('a 402 challenge is never counted as a completed payment', async () => {
  const body = await (await appWith(async () => POPULATED).request('/public/activity')).json() as any
  assert.equal(body.totals.x402_challenges, 7)
  assert.equal(body.totals.completed_paid_executions, null)
  assert.equal(body.funnel.payments_completed, null)
  assert.ok(body.disclosures.not_yet_measured.includes('totals.completed_paid_executions'))
  assert.ok(body.disclosures.not_yet_measured.includes('funnel.payments_completed'))
  assert.match(body.disclosures.x402_challenges, /not a payment/)
  assert.ok(body.recent_activity.some((i: any) => i.type === 'x402_challenge'))
  assert.ok(!body.recent_activity.some((i: any) => /pay/i.test(i.type) && i.type !== 'x402_challenge'))
})

test('unknown client names become "Other MCP client"; Other is exact (total minus classified)', async () => {
  const body = await (await appWith(async () => POPULATED).request('/public/activity')).json() as any
  const byLabel = Object.fromEntries(body.clients.map((c: any) => [c.label, c]))
  assert.deepEqual(byLabel['Codex MCP'], { label: 'Codex MCP', category: 'assistant', sessions: 3 })
  assert.deepEqual(byLabel['Glama'], { label: 'Glama', category: 'directory', sessions: 2 })
  assert.deepEqual(byLabel['Discovery probe'], { label: 'Discovery probe', category: 'discovery', sessions: 1 })
  assert.deepEqual(byLabel['Other MCP client'], { label: 'Other MCP client', category: 'other', sessions: 12 - 3 - 2 - 1 })
  assert.equal(body.clients.reduce((sum: number, c: any) => sum + c.sessions, 0), body.totals.sessions)
})

test('arbitrary or malicious client_name / tool values are never returned', async () => {
  const text = await (await appWith(async () => POPULATED).request('/public/activity')).text()
  for (const needle of [...MALICIOUS_NAMES, '<img src=x onerror=alert(1)>', 'brand-new-probe', 'evil.example', 'codex-mcp-client', 'GLAMA']) {
    assert.ok(!text.includes(needle), `leaked: ${needle.slice(0, 60)}`)
  }
})

test('no sensitive or raw telemetry columns appear anywhere in the response', async () => {
  const body = await (await appWith(async () => POPULATED).request('/public/activity')).json() as any
  const keys = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) { keys.add(k); walk(child) }
  }
  walk(body)
  for (const forbidden of ['id', 'client_name', 'client_version', 'method', 'outcome', 'status', 'transport', 'kind', 'publication', 'network', 'route', 'ip', 'address', 'recipient', 'sender', 'amount', 'transaction_hash', 'receipt_id', 'signature', 'arguments']) {
    assert.ok(!keys.has(forbidden), `response exposes key: ${forbidden}`)
  }
})

test('recent_activity uses only safe fields, drops unknown events and unregistered tools', async () => {
  const body = await (await appWith(async () => POPULATED).request('/public/activity')).json() as any
  const allowed = new Set(['occurred_at', 'type', 'surface', 'label', 'tool'])
  for (const item of body.recent_activity) {
    for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected key ${key}`)
    assert.ok(['public', 'paid', 'http'].includes(item.surface))
  }
  assert.deepEqual(body.recent_activity.map((i: any) => i.type), [
    'client_connected', 'tool_call_attempted', 'tool_call_attempted', 'tool_failed', 'tool_completed',
    'x402_challenge', 'receipt_created', 'tools_discovered',
  ])
  assert.equal(body.recent_activity[0].label, 'Other MCP client')
  assert.equal(body.recent_activity[1].tool, undefined, 'unregistered tool name dropped')
  assert.equal(body.recent_activity[2].tool, 'screen_wallet')
  assert.equal(body.recent_activity[5].surface, 'http')
})

test('a database failure returns 503 with no fabricated zeros', async () => {
  const res = await appWith(async () => { throw new Error('connection refused to db-host-secret') }).request('/public/activity')
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const text = await res.text()
  assert.ok(!text.includes('totals') && !text.includes('db-host-secret'))
})

test('headers: short CDN cache on success, static site-only CORS origin on every response', async () => {
  const app = appWith(async () => EMPTY)
  const ok = await app.request('/public/activity', { headers: { origin: 'https://attacker.example' } })
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=0, s-maxage=15, stale-while-revalidate=15')
  assert.equal(ok.headers.get('access-control-allow-origin'), ACTIVITY_ALLOWED_ORIGIN)
  const bad = await app.request('/public/activity?window=nope')
  assert.equal(bad.headers.get('access-control-allow-origin'), ACTIVITY_ALLOWED_ORIGIN)
})

test('classifyClient: case-insensitive exact names, -probe rule, and safe fallbacks', () => {
  assert.deepEqual(classifyClient('Anthropic/ClaudeAI'), { label: 'Claude', category: 'assistant' })
  assert.deepEqual(classifyClient('MCPScoringEngine'), { label: 'MCP Scoring Engine', category: 'discovery' })
  assert.deepEqual(classifyClient('mcpbeat'), { label: 'MCPBeat', category: 'monitoring' })
  assert.deepEqual(classifyClient('someone-new-probe'), { label: 'Discovery probe', category: 'discovery' })
  for (const raw of [null, undefined, 42, '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'x'.repeat(201)]) {
    assert.deepEqual(classifyClient(raw), { label: 'Other MCP client', category: 'other' }, String(raw).slice(0, 20))
  }
})
