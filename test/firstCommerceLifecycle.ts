/** D2.2A focused tests for scripts/first-commerce-lifecycle.ts's pure
 * validation logic (the safety gates that run BEFORE any signing).
 *
 * Run with: npx tsx test/firstCommerceLifecycle.ts
 *
 * Fully offline: these test the challenge-validation/spend-tracking pure
 * functions directly with fabricated challenge objects — no network call,
 * no key, no payment. LifecycleAbortError is thrown (never process.exit),
 * which is exactly what makes this file safe to run as a normal test.
 */
import assert from 'node:assert/strict'
import {
  validateChallenge,
  reserveSpend,
  resetSpendTrackerForTests,
  decodeChallenge,
  decodeSettlementResponse,
  LifecycleAbortError,
  NETWORK,
  ASSET,
  RECIPIENT,
  PER_CALL_ATOMIC,
  AGGREGATE_MAX_ATOMIC,
} from '../scripts/first-commerce-lifecycle.js'

function validChallenge(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        asset: ASSET,
        payTo: RECIPIENT,
        amount: PER_CALL_ATOMIC.toString(),
        ...overrides,
      },
    ],
  }
}

// --- challenge validation: the pre-signing safety gate --------------------

assert.equal(validateChallenge(validChallenge(), 'test'), PER_CALL_ATOMIC)
console.log('ok  a fully-matching challenge validates and returns the exact atomic amount')

assert.throws(() => validateChallenge(validChallenge({ network: 'eip155:1' }), 'test'), LifecycleAbortError, 'wrong network must abort')
assert.throws(() => validateChallenge(validChallenge({ network: 'base-sepolia' }), 'test'), LifecycleAbortError, 'wrong network format must abort')
console.log('ok  wrong network refused before signing')

assert.throws(
  () => validateChallenge(validChallenge({ asset: '0x0000000000000000000000000000000000dEaD' }), 'test'),
  LifecycleAbortError,
  'wrong asset must abort'
)
console.log('ok  wrong asset refused before signing')

assert.throws(
  () => validateChallenge(validChallenge({ payTo: '0x1111111111111111111111111111111111111111' }), 'test'),
  LifecycleAbortError,
  'wrong payTo must abort'
)
console.log('ok  wrong payTo (not OCD\'s own recipient) refused before signing')

assert.throws(() => validateChallenge(validChallenge({ amount: '9999' }), 'test'), LifecycleAbortError, 'amount below the exact price must abort')
assert.throws(() => validateChallenge(validChallenge({ amount: '10001' }), 'test'), LifecycleAbortError, 'amount above the exact price must abort')
assert.throws(() => validateChallenge(validChallenge({ amount: '1000000' }), 'test'), LifecycleAbortError, 'wildly excessive amount must abort')
console.log('ok  any amount other than EXACTLY 10000 atomic units refused before signing')

assert.throws(() => validateChallenge(validChallenge({ scheme: 'upto' }), 'test'), LifecycleAbortError)
console.log('ok  a non-"exact" scheme is refused')

assert.throws(() => validateChallenge({ x402Version: 1, accepts: [] }, 'test'), LifecycleAbortError)
console.log('ok  wrong x402Version refused')

// --- aggregate spend cap: the "no third payment" guarantee ----------------

resetSpendTrackerForTests()
reserveSpend(PER_CALL_ATOMIC, 'payment 1')
reserveSpend(PER_CALL_ATOMIC, 'payment 2')
assert.throws(
  () => reserveSpend(PER_CALL_ATOMIC, 'payment 3'),
  LifecycleAbortError,
  'a third payment attempt must be refused: it would exceed the $0.02 aggregate cap'
)
console.log('ok  a third payment attempt is refused: aggregate cap enforced, no looping possible')

resetSpendTrackerForTests()
assert.throws(() => reserveSpend(PER_CALL_ATOMIC + 1n, 'wrong amount'), LifecycleAbortError, 'reserveSpend must also reject a non-exact amount directly')
resetSpendTrackerForTests()
console.log('ok  reserveSpend independently rejects a non-exact amount, not only validateChallenge')

// --- decodeChallenge / decodeSettlementResponse -----------------------

{
  const encoded = Buffer.from(JSON.stringify(validChallenge())).toString('base64')
  const fakeResponse = new Response(null, { headers: { 'Payment-Required': encoded } })
  const decoded = decodeChallenge(fakeResponse)
  assert.equal(decoded.x402Version, 2)
}
assert.throws(() => decodeChallenge(new Response(null)), LifecycleAbortError, 'a 402 with no Payment-Required header must abort, not crash')
console.log('ok  decodeChallenge round-trips a real header and refuses a missing one')

{
  const encoded = Buffer.from(JSON.stringify({ success: true, transaction: '0xabc123', network: 'base', payer: RECIPIENT })).toString('base64')
  const decoded = decodeSettlementResponse(encoded)
  assert.equal(decoded.transaction, '0xabc123')
  assert.equal(decoded.success, true)
}
assert.throws(
  () => decodeSettlementResponse(Buffer.from(JSON.stringify({ success: true })).toString('base64')),
  LifecycleAbortError,
  'a settlement response with no transaction hash must abort'
)
console.log('ok  decodeSettlementResponse extracts the transaction hash and refuses a response missing one')

// --- pinned constants are exactly what the task specifies ------------------

assert.equal(NETWORK, 'eip155:8453')
assert.equal(ASSET.toLowerCase(), '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase())
assert.equal(RECIPIENT.toLowerCase(), '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'.toLowerCase())
assert.equal(PER_CALL_ATOMIC, 10_000n)
assert.equal(AGGREGATE_MAX_ATOMIC, 20_000n)
console.log('ok  pinned network/asset/recipient/amount/aggregate-cap constants match the task exactly')

console.log('\nAll D2.2A first-commerce-lifecycle safety-gate tests passed.')
