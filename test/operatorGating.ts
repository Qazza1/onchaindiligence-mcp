/** D2.2B tests for operator/src/gating.ts's pure UI-state decision logic.
 *
 * Run with: npx tsx test/operatorGating.ts
 *
 * Fully offline: no DOM, no wallet, no network. These are exactly the
 * "execute disabled" / "safe to retry" scenarios the D2.2B task asks to be
 * proven, expressed as pure function calls against fabricated UI state.
 */
import assert from 'node:assert/strict'
import { canExecuteLifecycle, canRetryTargetStep, BASE_CHAIN_ID } from '../operator/src/gating.js'
import { AGGREGATE_MAX_ATOMIC } from '../src/lifecycleCore.js'

const READY_STATE = {
  walletConnected: true,
  chainId: BASE_CHAIN_ID,
  inspectionStatus: 'ALLOW' as const,
  confirmed: true,
  usdcBalanceAtomic: AGGREGATE_MAX_ATOMIC,
}

// --- the fully-ready state is the only one that allows execution ----------
assert.equal(canExecuteLifecycle(READY_STATE).allowed, true)
console.log('ok  fully-ready state allows execution')

// --- wallet not connected ---------------------------------------------------
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, walletConnected: false })
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.includes('wallet not connected'))
}
console.log('ok  wallet not connected -> execute disabled')

// --- wrong chain -------------------------------------------------------------
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, chainId: 1 })
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.includes('wallet is not on Base mainnet'))
}
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, chainId: null })
  assert.equal(verdict.allowed, false)
}
console.log('ok  wrong/unknown chain -> execute disabled')

// --- insufficient USDC ---------------------------------------------------
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, usdcBalanceAtomic: AGGREGATE_MAX_ATOMIC - 1n })
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.some((r) => r.includes('insufficient USDC')))
}
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, usdcBalanceAtomic: null })
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.some((r) => r.includes('USDC balance not yet known')))
}
console.log('ok  insufficient/unknown USDC balance -> execute disabled with a clear reason')

// --- free inspection not ALLOW -----------------------------------------------
for (const status of ['idle', 'pending', 'BLOCKED', 'ERROR'] as const) {
  const verdict = canExecuteLifecycle({ ...READY_STATE, inspectionStatus: status })
  assert.equal(verdict.allowed, false, `inspectionStatus=${status} must disable execution`)
  assert.ok(verdict.reasons.includes('free inspection has not returned ALLOW'))
}
console.log('ok  free inspection anything other than ALLOW -> execute disabled')

// --- confirmation checkbox ----------------------------------------------------
{
  const verdict = canExecuteLifecycle({ ...READY_STATE, confirmed: false })
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.includes('operator has not confirmed the payment plan'))
}
console.log('ok  unconfirmed payment plan -> execute disabled')

// --- multiple simultaneous reasons are all reported, not just the first ------
{
  const verdict = canExecuteLifecycle({
    walletConnected: false,
    chainId: 1,
    inspectionStatus: 'idle',
    confirmed: false,
    usdcBalanceAtomic: null,
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reasons.length, 5)
}
console.log('ok  every failing precondition is reported, not just the first')

// --- retry-safety boundary: only safe before any signature was requested ----
assert.equal(canRetryTargetStep('before-signature-requested'), true)
assert.equal(canRetryTargetStep('after-signature-requested'), false)
assert.equal(canRetryTargetStep(null), false)
console.log('ok  "Retry target step" is only ever safe when no wallet signature could have been requested yet')

console.log('\nAll D2.2B operator-gating tests passed.')
