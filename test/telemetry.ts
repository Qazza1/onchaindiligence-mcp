/** Focused tests for the MCP usage-telemetry additions (mcp.session,
 * mcp.request on both surfaces, mcp.tool_result, receipt.created) and the
 * privacy allowlist that guards all of them.
 *
 * Run with: npx tsx test/telemetry.ts
 *
 * Fully offline: DATABASE_URL is deliberately left unset so every
 * durable-persistence attempt exercises the real "best effort, never throws"
 * fallback path rather than a mock.
 */

import assert from 'node:assert/strict'

delete process.env.DATABASE_URL

// Any unhandled rejection during this run is a real bug: best-effort
// persistence must never let a rejection escape.
let unhandled: unknown = null
process.on('unhandledRejection', (error: unknown) => {
  unhandled = error
})

const { recordEvent, readMcpEnvelope, withToolTelemetry } = await import('../src/telemetry.js')

function captureLogs(run: () => void | Promise<void>): Promise<string[]> {
  const logged: string[] = []
  const realLog = console.log
  console.log = (line?: any) => {
    logged.push(String(line))
  }
  return Promise.resolve(run()).finally(() => {
    console.log = realLog
  }).then(() => logged)
}

// --- 1. mcp.session emits only the allowlisted client-identity fields -----

{
  const logged = await captureLogs(() => {
    recordEvent('mcp.session', {
      surface: 'public',
      client_name: 'claude-ai',
      client_version: '1.2.3',
      transport: 'streamable-http',
      // Not in the allowlist -- must be dropped.
      ...({ sessionId: 'abc-123', ip: '203.0.113.4', authorization: 'Bearer secret' } as any),
    })
  })
  assert.equal(logged.length, 1)
  assert.ok(logged[0].startsWith('x402_funnel '))
  const parsed = JSON.parse(logged[0].slice('x402_funnel '.length))
  assert.deepEqual(Object.keys(parsed).sort(), [
    'client_name',
    'client_version',
    'event',
    'surface',
    'transport',
  ])
  assert.equal(parsed.client_name, 'claude-ai')
  assert.equal(parsed.client_version, '1.2.3')
  assert.equal(parsed.surface, 'public')
  console.log('ok  mcp.session emits only surface/client_name/client_version/transport')
}

// --- 2. receipt.created emits only kind/publication/surface/network -------

{
  const logged = await captureLogs(() => {
    recordEvent('receipt.created', {
      kind: 'PREFLIGHT',
      publication: 'private',
      surface: 'paid',
      network: 'eip155:8453',
      // Not in the allowlist -- must be dropped, even if a future caller
      // adds one of these by mistake.
      ...({
        receipt_id: 'OCD-RCP-AAAA-BBBB-CCCC-DDDD',
        payer: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        sender: '0xsender',
        recipient: '0xrecipient',
        amount: '1.00',
        transaction_hash: '0xhash',
        signature: 'base64sig==',
        proof: { some: 'thing' },
        policy: { max_amount: '5.00' },
      } as any),
    })
  })
  assert.equal(logged.length, 1)
  const parsed = JSON.parse(logged[0].slice('x402_funnel '.length))
  assert.deepEqual(Object.keys(parsed).sort(), ['event', 'kind', 'network', 'publication', 'surface'])
  for (const forbidden of [
    'OCD-RCP-AAAA-BBBB-CCCC-DDDD',
    '0xdeadbeef',
    '0xsender',
    '0xrecipient',
    '1.00',
    '0xhash',
    'base64sig==',
  ]) {
    assert.ok(!logged[0].includes(forbidden), `receipt.created leaked ${forbidden}`)
  }
  console.log('ok  receipt.created emits only kind/publication/surface/network, never receipt content')
}

// --- 3. withToolTelemetry never leaks arguments, and reports outcome ------

{
  // 3a. Successful call -> outcome "ok", tool args never appear.
  const okArgs = {
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    recipient: '0xrecipientrecipientrecipientrecipient01',
    amount: '123.45',
    _meta: { 'x402/payment': 'signed-payment-header-value' },
  }
  const wrapped = withToolTelemetry('paid', 'screen_wallet', async (_args: typeof okArgs) => ({
    content: [{ type: 'text', text: 'ok' }],
  }))
  const logged = await captureLogs(async () => {
    const result = await wrapped(okArgs)
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] })
  })
  assert.equal(logged.length, 1)
  const parsed = JSON.parse(logged[0].slice('x402_funnel '.length))
  assert.deepEqual(parsed, { event: 'mcp.tool_result', surface: 'paid', tool: 'screen_wallet', outcome: 'ok' })
  for (const forbidden of [
    '0xdeadbeef',
    'recipientrecipient',
    '123.45',
    'signed-payment-header-value',
  ]) {
    assert.ok(!logged[0].includes(forbidden), `mcp.tool_result leaked ${forbidden}`)
  }
  console.log('ok  withToolTelemetry(ok) emits surface/tool/outcome only, never tool arguments')
}

{
  // 3b. Callback resolves with { isError: true } -> outcome "error".
  const wrapped = withToolTelemetry('paid', 'screen_wallet', async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Sanctions oracle unreachable for 0xdeadbeef' }],
  }))
  const logged = await captureLogs(async () => {
    await wrapped()
  })
  const parsed = JSON.parse(logged[0].slice('x402_funnel '.length))
  assert.equal(parsed.outcome, 'error')
  assert.ok(!logged[0].includes('0xdeadbeef'), 'mcp.tool_result leaked error message content')
  console.log('ok  withToolTelemetry(isError:true result) records outcome "error"')
}

{
  // 3c. Callback throws -> outcome "error", AND the original error still
  // propagates unchanged (telemetry never swallows the real failure).
  const wrapped = withToolTelemetry('public', 'inspect_payment', async () => {
    throw new Error('boom for recipient 0xrecipientrecipientrecipientrecipient01')
  })
  let threw = false
  const logged = await captureLogs(async () => {
    try {
      await wrapped()
    } catch (err: any) {
      threw = true
      assert.equal(err.message, 'boom for recipient 0xrecipientrecipientrecipientrecipient01')
    }
  })
  assert.ok(threw, 'withToolTelemetry must rethrow the original error')
  const parsed = JSON.parse(logged[0].slice('x402_funnel '.length))
  assert.deepEqual(parsed, { event: 'mcp.tool_result', surface: 'public', tool: 'inspect_payment', outcome: 'error' })
  assert.ok(!logged[0].includes('0xrecipient'), 'mcp.tool_result leaked a thrown error message')
  console.log('ok  withToolTelemetry(throws) rethrows unchanged and records outcome "error"')
}

// --- 4. mcp.request (both surfaces) still extracts method/tool only -------

assert.deepEqual(
  readMcpEnvelope(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'inspect_payment', arguments: { recipient: '0xrecipientrecipientrecipientrecipient01', amount: '9.99' } },
    })
  ),
  { method: 'tools/call', tool: 'inspect_payment' }
)
console.log('ok  readMcpEnvelope still extracts method/tool only, never arguments (both surfaces)')

// --- 5. Exhaustive sensitive-field leak check across every event emitted --

{
  const forbiddenValues = [
    'wallet=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // tool arguments
    '0xrecipientrecipientrecipientrecipient01', // recipient
    '42.00', // amount
    'Bearer super-secret-token', // authorization header
    'x402-signed-payment-header-blob', // X-PAYMENT header
    'MEUCIQDsignaturebytes==', // signature
    '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"screen_wallet","arguments":{"address":"0xdeadbeef"}}}', // raw request body
  ]
  const attemptedInjection: Record<string, unknown> = {
    tool_arguments: forbiddenValues[0],
    recipient: forbiddenValues[1],
    amount: forbiddenValues[2],
    authorization: forbiddenValues[3],
    'x-payment': forbiddenValues[4],
    signature: forbiddenValues[5],
    body: forbiddenValues[6],
  }
  const logged = await captureLogs(() => {
    recordEvent('mcp.request', { surface: 'paid', method: 'tools/call', tool: 'screen_wallet', ...(attemptedInjection as any) })
    recordEvent('mcp.tool_result', { surface: 'paid', tool: 'screen_wallet', outcome: 'ok', ...(attemptedInjection as any) })
    recordEvent('mcp.session', { surface: 'paid', client_name: 'x', client_version: '1', transport: 'streamable-http', ...(attemptedInjection as any) })
    recordEvent('receipt.created', { kind: 'PREFLIGHT', publication: 'private', ...(attemptedInjection as any) })
    recordEvent('http.request', { route: '/x402/screen/:address', status: 402, outcome: 'challenge', ...(attemptedInjection as any) })
  })
  assert.equal(logged.length, 5)
  for (const line of logged) {
    for (const forbidden of forbiddenValues) {
      assert.ok(!line.includes(forbidden), `event leaked forbidden value: ${forbidden}\nline: ${line}`)
    }
  }
  console.log('ok  none of tool arguments / recipient / amount / authorization / X-PAYMENT / signature / request body can enter any event')
}

// --- 6. Best-effort durable persistence never throws or rejects -----------

{
  // DATABASE_URL is deliberately unset (see top of file). recordEvent must
  // still return synchronously without throwing, and must never produce an
  // unhandled rejection once its fire-and-forget insert settles.
  assert.doesNotThrow(() => recordEvent('mcp.request', { surface: 'public', method: 'tools/list' }))
  // Give the fire-and-forget persistence attempt a turn to settle.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(unhandled, null, `best-effort persistence produced an unhandled rejection: ${String(unhandled)}`)
  console.log('ok  recordEvent never throws and never rejects when DATABASE_URL is unset')
}

console.log('\nAll telemetry tests passed.')
