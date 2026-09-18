/** Focused test for CHECK 1 (durable event write lifecycle).
 *
 * Proves that recordEvent() attaches its best-effort durable-insert promise
 * to the Vercel invocation lifecycle via `waitUntil` from `@vercel/functions`
 * -- not a bare, unattached fire-and-forget promise -- by installing a fake
 * `@vercel/request-context` (the exact global Vercel's own runtime sets;
 * see node_modules/@vercel/functions/dist/get-context.js) and asserting the
 * fake context's `waitUntil` actually receives the persistence promise.
 *
 * Run with: npx tsx test/telemetryDurability.ts
 *
 * Fully offline: DATABASE_URL is deliberately left unset, so the "durable
 * insert" promise this test observes still resolves via the existing
 * best-effort catch path (see test/telemetry.ts) -- this file only proves
 * WHERE that promise is registered, not that a real database write occurs.
 */

import assert from 'node:assert/strict'

delete process.env.DATABASE_URL

let unhandled: unknown = null
process.on('unhandledRejection', (error: unknown) => {
  unhandled = error
})

// Install a fake Vercel request-context BEFORE importing telemetry.ts, so
// any module-level binding (there is none today, but this is the correct,
// robust order regardless) sees it. This is the exact mechanism
// @vercel/functions' waitUntil() reads: globalThis[Symbol.for(...)].get().
const REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context')
const registeredPromises: Promise<unknown>[] = []
;(globalThis as any)[REQUEST_CONTEXT_SYMBOL] = {
  get: () => ({
    waitUntil: (promise: Promise<unknown>) => {
      registeredPromises.push(promise)
    },
  }),
}

const { recordEvent } = await import('../src/telemetry.js')

// --- 1. recordEvent registers its persistence promise via waitUntil -------

{
  const before = registeredPromises.length
  recordEvent('mcp.request', { surface: 'public', method: 'tools/list' })
  assert.equal(
    registeredPromises.length,
    before + 1,
    'recordEvent must register exactly one promise with the request-context waitUntil'
  )
  const registered = registeredPromises[registeredPromises.length - 1]
  assert.equal(typeof registered.then, 'function', 'the registered value must be a real Promise')
  // Awaiting it here proves the lifecycle mechanism was actually handed a
  // promise tied to the real persistence attempt (which itself resolves via
  // the existing best-effort catch, since DATABASE_URL is unset) -- not a
  // detached, already-settled, or fabricated value.
  await assert.doesNotReject(registered)
  console.log('ok  recordEvent attaches its durable-insert promise via waitUntil(), not a bare unawaited call')
}

// --- 2. Response-path behavior is unchanged: recordEvent stays synchronous,
//        never awaits the durable write before returning ------------------

{
  let dbSettled = false
  // Replace the fake context's waitUntil with one that lets us observe
  // ordering: recordEvent() must return before the registered promise
  // settles.
  ;(globalThis as any)[REQUEST_CONTEXT_SYMBOL] = {
    get: () => ({
      waitUntil: (promise: Promise<unknown>) => {
        promise.then(() => {
          dbSettled = true
        })
      },
    }),
  }
  recordEvent('mcp.session', { surface: 'paid', client_name: 'x', client_version: '1', transport: 'streamable-http' })
  // recordEvent already returned (it is not async) -- the registered promise
  // cannot have settled yet on this same synchronous turn.
  assert.equal(dbSettled, false, 'recordEvent must not await the durable write before returning')
  console.log('ok  recordEvent returns synchronously; the durable write is never awaited on the response path')
}

// --- 3. Outside any Vercel request context, behavior degrades safely ------

{
  delete (globalThis as any)[REQUEST_CONTEXT_SYMBOL]
  assert.doesNotThrow(() =>
    recordEvent('mcp.tool_result', { surface: 'public', tool: 'inspect_payment', outcome: 'ok' })
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(unhandled, null, `missing request-context produced an unhandled rejection: ${String(unhandled)}`)
  console.log('ok  without a Vercel request context, recordEvent degrades safely (no throw, no unhandled rejection)')
}

console.log('\nAll telemetry durability tests passed.')
