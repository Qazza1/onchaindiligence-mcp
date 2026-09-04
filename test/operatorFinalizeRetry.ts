/** D2.2B2 tests for operator/src/finalizeClient.ts's pure finalize-retry logic.
 *
 * Run with: npx tsx test/operatorFinalizeRetry.ts
 *
 * Fully offline: no DOM, no wallet, no network. This module has no import of
 * payingFetch/wrapFetchWithPayment/wallet machinery at all -- that absence is
 * itself the guarantee that a "retry finalization" action can never trigger
 * a payment. These tests verify the request/capability-handling behavior.
 */
import assert from 'node:assert/strict'
import { attemptFinalize, type FinalizeCapabilityHolder } from '../operator/src/finalizeClient.js'

const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const PREFLIGHT_ID = 'OCD-RCP-TEST-0000-0000-0000'
const VALID_VERIFICATION = { state: 'VALID', code: 'ok', message: 'ok' }

function makeHolder(initial: string | null): FinalizeCapabilityHolder & { cleared: boolean } {
  let value = initial
  return {
    cleared: false,
    get: () => value,
    clear() {
      value = null
      this.cleared = true
    },
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function commerceEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'onchaindiligence.public-action-receipt.v1',
    receipt: {
      receipt_type: 'COMMERCE',
      receipt_id: 'OCD-RCP-COMMERCE-0000-0000',
      links: { preflight_receipt_id: PREFLIGHT_ID, agent_evidence_bundle_digest: null },
      decision: { status: 'ALLOW', authorized: true, reasons: [] },
      execution: { status: 'CONFIRMED', provider: 'x402', transaction_hash: TX_HASH, submitted_at: null, confirmed_at: '2026-09-04T00:00:00.000Z' },
      settlement: { status: 'CONFIRMED', detail: 'ok' },
      ...overrides,
    },
    proof: { signed: true },
  }
}

// --- pending (425/503): capability retained, same tx re-sent -------------

for (const status of [425, 503]) {
  const holder = makeHolder('secret-capability-token')
  let calledWith: { transactionHash: string; capability: string } | null = null
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async (transactionHash, capability) => {
      calledWith = { transactionHash, capability }
      return jsonResponse(status, { error: 'not yet definitive', reason: 'insufficient-confirmations' }, { 'retry-after': '7' })
    },
    verifyReceipt: async () => VALID_VERIFICATION,
  })
  assert.equal(outcome.kind, 'pending')
  if (outcome.kind === 'pending') {
    assert.equal(outcome.reason, 'insufficient-confirmations')
    assert.equal(outcome.retryAfterSeconds, 7)
  }
  assert.equal(holder.cleared, false, `capability must be retained on a ${status} pending response`)
  assert.equal(holder.get(), 'secret-capability-token')
  assert.deepEqual(calledWith, { transactionHash: TX_HASH, capability: 'secret-capability-token' })
}
console.log('ok  425/503 pending responses retain the capability and report reason/retry-after')

// --- definitive success: capability cleared, same tx used ----------------

{
  const holder = makeHolder('secret-capability-token')
  let calledWith: { transactionHash: string; capability: string } | null = null
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async (transactionHash, capability) => {
      calledWith = { transactionHash, capability }
      return jsonResponse(200, commerceEnvelope())
    },
    verifyReceipt: async () => VALID_VERIFICATION,
  })
  assert.equal(outcome.kind, 'done')
  assert.equal(holder.cleared, true, 'capability must be cleared after a definitive successful finalization')
  assert.equal(holder.get(), null)
  assert.deepEqual(calledWith, { transactionHash: TX_HASH, capability: 'secret-capability-token' })
}
console.log('ok  definitive success clears the capability')

// --- terminal failure (e.g. expired/invalid capability, 401/409/400): cleared ---

for (const status of [401, 409, 400]) {
  const holder = makeHolder('secret-capability-token')
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async () => jsonResponse(status, { error: 'terminal failure' }),
    verifyReceipt: async () => VALID_VERIFICATION,
  })
  assert.equal(outcome.kind, 'failed')
  assert.equal(holder.cleared, true, `capability must be cleared on a terminal ${status} response`)
}
console.log('ok  terminal (non-pending) failures clear the capability')

// --- no capability held: fails immediately, never calls postFinalize -----

{
  const holder = makeHolder(null)
  let called = false
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async () => {
      called = true
      return jsonResponse(200, commerceEnvelope())
    },
    verifyReceipt: async () => VALID_VERIFICATION,
  })
  assert.equal(outcome.kind, 'failed')
  assert.equal(called, false)
}
console.log('ok  no capability held -> fails without any network call')

// --- receipt that fails independent VALID re-verification is rejected ----

{
  const holder = makeHolder('secret-capability-token')
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async () => jsonResponse(200, commerceEnvelope()),
    verifyReceipt: async () => ({ state: 'INVALID', code: 'signature-invalid', message: 'bad' }),
  })
  assert.equal(outcome.kind, 'failed')
  assert.equal(holder.cleared, true)
}
console.log('ok  a Commerce Receipt that fails independent VALID re-verification is rejected')

// --- a receipt with the wrong preflight link is rejected ------------------

{
  const holder = makeHolder('secret-capability-token')
  const outcome = await attemptFinalize(TX_HASH, PREFLIGHT_ID, holder, {
    postFinalize: async () => jsonResponse(200, commerceEnvelope({ links: { preflight_receipt_id: 'OCD-RCP-WRONG-0000-0000-0000', agent_evidence_bundle_digest: null } })),
    verifyReceipt: async () => VALID_VERIFICATION,
  })
  assert.equal(outcome.kind, 'failed')
}
console.log('ok  a Commerce Receipt referencing a different preflight is rejected')

// --- architectural guarantee: this module has no payment/wallet import at all ---

{
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../operator/src/finalizeClient.ts', import.meta.url), 'utf8')
  for (const forbidden of ['payingFetch', 'wrapFetchWithPayment', 'signTypedData', 'x402Client', 'ExactEvmScheme', 'createWalletClient']) {
    assert.ok(!source.includes(forbidden), `finalizeClient.ts must never reference ${forbidden} -- retrying finalization must be architecturally incapable of paying`)
  }
}
console.log('ok  finalizeClient.ts contains no payment/wallet-signing code at all (architectural guarantee, not just a runtime check)')

console.log('\nAll D2.2B2 operator-finalize-retry tests passed.')
