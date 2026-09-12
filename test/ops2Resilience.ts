/** OPS-V2: x402/MCP transport resilience.
 *
 * Root cause (confirmed by reading the installed package sources, see
 * facilitatorResilience.ts's header):
 *   1. mcp-handler@1.1.0's Streamable HTTP dispatch only implements GET
 *      (405), DELETE (405), and POST for /mcp -- HEAD and OPTIONS fall
 *      through with no response ever written, hanging until the platform's
 *      ~300s function timeout.
 *   2. x402/verify's useFacilitator() (POST /mcp paid tools) and
 *      @x402/core's x402ResourceServer.initialize() (discovery.ts's /x402/*
 *      paymentMiddleware, fired eagerly and un-awaited at module load) both
 *      call the CDP facilitator via a plain, timeout-less `fetch`. An
 *      unreachable facilitator can hang a request indefinitely, and the
 *      eager, un-awaited init promise can become an unhandled rejection
 *      that crashes the whole process (Node's default
 *      --unhandled-rejections=throw), taking unrelated concurrent requests
 *      down with it.
 *
 * Run with: npx tsx test/ops2Resilience.ts
 */
import assert from 'node:assert/strict'

process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

// ---------------------------------------------------------------------
// Section 1: wrapFetchWithFacilitatorTimeout -- pure, offline, no real
// network or real app import needed. Covers test-matrix C/D/E/F/G/H.
// ---------------------------------------------------------------------
{
  const { wrapFetchWithFacilitatorTimeout, FacilitatorTimeoutError } = await import(
    '../src/facilitatorResilience.js'
  )
  const PREFIX = 'https://facilitator.example/x402'
  const OTHER_URL = 'https://not-the-facilitator.example/rpc'

  // C: facilitator success -- normal behavior passes through untouched.
  {
    const fakeFetch = (async (input: unknown) => {
      assert.equal(input, `${PREFIX}/verify`)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 50)
    const res = await wrapped(`${PREFIX}/verify`)
    assert.equal(res.status, 200)
    console.log('ok  facilitator success: normal behavior passes through the wrapper untouched')
  }

  // Non-facilitator URLs are never touched by the wrapper at all.
  {
    let called = false
    const fakeFetch = (async () => {
      called = true
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 50)
    const res = await wrapped(OTHER_URL)
    assert.equal(res.status, 200)
    assert.ok(called)
    console.log('ok  a non-facilitator URL is never bounded or otherwise altered by the wrapper')
  }

  // D: facilitator 401 -- passes through as a normal (non-2xx) response, not swallowed or hung.
  {
    const fakeFetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 50)
    const res = await wrapped(`${PREFIX}/supported`)
    assert.equal(res.status, 401)
    console.log('ok  facilitator 401 is returned promptly, not swallowed or hung')
  }

  // E: facilitator network error (e.g. socket reset) -- rejects promptly, not hung.
  {
    const fakeFetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 50)
    await assert.rejects(() => wrapped(`${PREFIX}/verify`), TypeError)
    console.log('ok  a facilitator network error rejects promptly, not hung')
  }

  // F: facilitator never resolves -- the timeout fires; the returned promise
  // rejects with FacilitatorTimeoutError well before any real hang could
  // occur, and the abandoned underlying call is aborted (signal fires).
  {
    let abortedSignalSeen = false
    const fakeFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortedSignalSeen = true
          reject(init.signal!.reason)
        })
      })) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 30)
    const started = Date.now()
    await assert.rejects(() => wrapped(`${PREFIX}/supported`), FacilitatorTimeoutError)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1000, `expected a bounded ~30ms timeout, took ${elapsed}ms`)
    assert.ok(abortedSignalSeen, 'expected the underlying request to be aborted, not merely abandoned')
    console.log(`ok  a facilitator request that never resolves times out in ${elapsed}ms, never hangs, and aborts the underlying call`)
  }

  // G: retry after a failed/timed-out call -- the wrapper is not poisoned by
  // one failure; a later call to the same wrapper instance behaves normally
  // once the backing fetch recovers.
  {
    let attempt = 0
    const fakeFetch = ((input: unknown, init?: RequestInit) => {
      attempt += 1
      if (attempt === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
      }
      return Promise.resolve(new Response('ok', { status: 200 }))
    }) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 30)
    await assert.rejects(() => wrapped(`${PREFIX}/supported`), FacilitatorTimeoutError)
    const recovered = await wrapped(`${PREFIX}/supported`)
    assert.equal(recovered.status, 200)
    assert.equal(attempt, 2)
    console.log('ok  a later call recovers normally after an earlier timeout -- the wrapper is never permanently poisoned')
  }

  // H: concurrent calls to the facilitator each get their own independent
  // bound -- one slow/never-resolving call does not affect a concurrent
  // healthy one, and there is no shared mutable state corrupting either.
  {
    const fakeFetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/slow')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
      }
      return Promise.resolve(new Response('ok', { status: 200 }))
    }) as typeof fetch
    const wrapped = wrapFetchWithFacilitatorTimeout(fakeFetch, PREFIX, 30)
    const [slow, fast] = await Promise.allSettled([wrapped(`${PREFIX}/slow`), wrapped(`${PREFIX}/fast`)])
    assert.equal(slow.status, 'rejected')
    assert.ok((slow as PromiseRejectedResult).reason instanceof FacilitatorTimeoutError)
    assert.equal(fast.status, 'fulfilled')
    assert.equal((fast as PromiseFulfilledResult<Response>).value.status, 200)
    console.log('ok  concurrent facilitator calls are bounded independently -- a hung one never blocks a healthy one')
  }
}

// ---------------------------------------------------------------------
// Section 2: HEAD/OPTIONS /mcp short-circuit, and the paid/public surface
// regression check, against the real app (index.ts). Covers A/B/I.
// ---------------------------------------------------------------------
{
  let fetchCalls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    fetchCalls.push(url)
    throw new Error(`unexpected network call in offline test: ${url}`)
  }) as typeof fetch

  const { default: app } = await import('../index.js')

  // A: HEAD /mcp returns promptly, deterministically, and never touches the
  // network (i.e. never reaches the facilitator/payment machinery).
  {
    fetchCalls = []
    const started = Date.now()
    const res = await app.request('/mcp', { method: 'HEAD' })
    const elapsed = Date.now() - started
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'POST')
    assert.equal(fetchCalls.length, 0, `expected no network calls, got: ${fetchCalls.join(', ')}`)
    assert.ok(elapsed < 2000, `expected a prompt response, took ${elapsed}ms`)
    console.log(`ok  HEAD /mcp returns 405 promptly (${elapsed}ms) with no facilitator/network call`)
  }

  // B: OPTIONS /mcp returns promptly, deterministically, and never touches
  // the network.
  {
    fetchCalls = []
    const started = Date.now()
    const res = await app.request('/mcp', { method: 'OPTIONS' })
    const elapsed = Date.now() - started
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('allow'), 'POST')
    assert.equal(fetchCalls.length, 0, `expected no network calls, got: ${fetchCalls.join(', ')}`)
    assert.ok(elapsed < 2000, `expected a prompt response, took ${elapsed}ms`)
    console.log(`ok  OPTIONS /mcp returns 204 promptly (${elapsed}ms) with no facilitator/network call`)
  }

  // I: regression -- public/free surfaces are unaffected by this change.
  // Note on /x402/* below: requireSigningReadiness (index.ts, pre-existing,
  // untouched by OPS-V2) gates the ENTIRE /x402/* namespace before any
  // payment-specific logic runs, and in this offline test environment the
  // attestation-readiness check itself cannot succeed (no real attestation
  // service reachable) -- so these paid routes correctly return 503 here,
  // exactly as they would have before OPS-V2. What matters for THIS
  // regression check is that they still respond promptly and cleanly
  // (never hang, never 5xx-crash the process) -- input-validation-before-
  // payment behavior for these routes is already covered by test/x402Routes.ts
  // (which tests discovery.ts's routes directly, without requireSigningReadiness),
  // and the discovery.ts facilitator-outage 503 mapping this task adds is
  // covered in isolation in Section 3 below.
  {
    const root = await app.request('/')
    assert.equal(root.status, 200)

    const openapi = await app.request('/openapi.json')
    assert.equal(openapi.status, 200)

    const wellKnown = await app.request('/.well-known/x402')
    assert.equal(wellKnown.status, 200)

    const bridge = await app.request('/inspect/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(bridge.status, 400)

    for (const path of ['/x402/preflight-payment', '/x402/preflight-allowance', '/x402/preflight-swap']) {
      const started = Date.now()
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const elapsed = Date.now() - started
      assert.ok(res.status >= 400 && res.status < 600, `${path}: expected a clean 4xx/5xx, got ${res.status}`)
      assert.ok(elapsed < 5000, `${path}: expected a bounded response, took ${elapsed}ms`)
    }

    // Circle's webhook route must still fail closed (401) on a signature-less
    // request -- unaffected by the /mcp and facilitator-timeout changes.
    const circleWebhook = await app.request('/webhooks/circle/transaction-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'transactions.outbound' }),
    })
    assert.equal(circleWebhook.status, 401)

    console.log(
      'ok  regression: root/openapi/well-known, bridge inspect, payment/allowance/swap preflight (bounded, no hang/crash), and the Circle webhook route are all unaffected'
    )
  }

  // POST /mcp with a normal JSON-RPC body still reaches the real MCP
  // handler (never intercepted by the HEAD/OPTIONS short-circuit).
  {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.ok(
      [200, 401, 406, 503].includes(res.status),
      `unexpected POST /mcp status ${res.status}`
    )
    console.log('ok  POST /mcp still reaches the real MCP handler (not intercepted by the HEAD/OPTIONS short-circuit)')
  }
}

// ---------------------------------------------------------------------
// Section 3: discovery.ts's NEW facilitator-outage -> 503 mapping, tested
// in isolation on a minimal discovery-only app (mirrors test/x402Routes.ts's
// own pattern exactly: a bare Hono() with only mountDiscovery(app), so
// index.ts's requireSigningReadiness never gates the request and a
// STRUCTURALLY VALID preflight body reaches the payment middleware).
// ---------------------------------------------------------------------
{
  // Same documented, pre-existing convention as test/x402Routes.ts: with
  // placeholder CDP credentials, the facilitator's eager, un-awaited
  // syncFacilitatorOnStart init always fails -- expected and swallowed here
  // exactly as that file already does, now redundant with (but harmless
  // alongside) facilitatorResilience.ts's own global guard.
  process.on('unhandledRejection', (error: unknown) => {
    const message = String((error as Error)?.message ?? error)
    if (message.includes('no supported payment kinds loaded from any facilitator')) return
    throw error
  })

  const { Hono } = await import('hono')
  const { mountDiscovery } = await import('../src/discovery.js')
  const app = new Hono()
  mountDiscovery(app)

  const validPreflightBody = {
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
  }

  const started = Date.now()
  const res = await app.request('/x402/preflight-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validPreflightBody),
  })
  const elapsed = Date.now() - started
  const body = (await res.json()) as { error?: string }
  assert.equal(res.status, 503)
  assert.equal(body.error, 'x402 facilitator temporarily unavailable')
  assert.equal(res.headers.get('retry-after'), '5')
  assert.ok(elapsed < 5000, `expected a bounded response, took ${elapsed}ms`)
  console.log(
    `ok  a structurally valid /x402/preflight-payment request during a facilitator outage returns a clean, bounded 503 (${elapsed}ms), never a bare 500 or a hang`
  )
}

console.log('\nAll OPS-V2 resilience tests passed.')
process.exit(0)
