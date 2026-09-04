/** D2.2 focused tests for Commerce Receipt construction (settlement matching semantics).
 *
 * Run with: npx tsx test/commerceReceipt.ts
 *
 * Fully offline: SettlementObservation fixtures are constructed directly —
 * no RPC call is made anywhere in this file.
 */
import assert from 'node:assert/strict'
import { buildCommerceReceiptCore, type FinalizationExecutionInput } from '../src/commerceReceipt.js'
import { finalizeReceiptCore, type Receipt, type ReceiptCoreFields } from '../src/receipts.js'
import type { SettlementObservation } from '../src/settlement.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const OTHER_RECIPIENT = '0x1111111111111111111111111111111111111111'
const SENDER = '0x2222222222222222222222222222222222222222'
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`

function preflightReceipt(overrides: Partial<ReceiptCoreFields['action']> = {}): Receipt {
  const core: ReceiptCoreFields = {
    receipt_type: 'PREFLIGHT',
    issued_at: '2026-09-04T00:00:00.000Z',
    action: {
      kind: 'PAYMENT',
      resource: null,
      network: 'eip155:8453',
      asset: USDC,
      amount: '1.00',
      sender: null,
      recipient: RECIPIENT,
      ...overrides,
    },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'x' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  }
  return finalizeReceiptCore(core)
}

const EXECUTION: FinalizationExecutionInput = {
  transaction_hash: TX_HASH,
  execution_provider: 'x402',
  provider_reference: null,
  result_digest: null,
}

function checkFor(checks: ReturnType<typeof buildCommerceReceiptCore>['checks'], id: string) {
  return checks.find((c) => c.id === id)
}

// --- exact matching transfer -> CONFIRMED / CONFIRMED --------------------

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'CONFIRMED')
  assert.equal(built.settlement.status, 'CONFIRMED')
  assert.equal(checkFor(built.checks, 'settlement-confirmed')?.result, 'PASS')
  assert.equal(checkFor(built.checks, 'execution-matches-preflight')?.result, 'PASS')
  assert.equal(checkFor(built.checks, 'recipient-matches-preflight')?.result, 'PASS')
  assert.equal(checkFor(built.checks, 'amount-matches-preflight')?.result, 'PASS')
  assert.equal(checkFor(built.checks, 'sender-matches-preflight')?.result, 'NOT_CHECKED', 'preflight sender was null -> NOT_CHECKED, never PASS/FAIL')
  assert.equal(built.action.amount, '1', 'canonical decimal form has no redundant trailing zeros')
  assert.equal(built.action.recipient, RECIPIENT)
  assert.equal(built.execution.confirmed_at, '2026-09-04T00:01:00.000Z')
}
console.log('ok  exact matching Base USDC transfer -> execution CONFIRMED, settlement CONFIRMED')

// --- reverted transaction -> FAILED / NOT_CONFIRMED ----------------------

{
  const observation: SettlementObservation = {
    state: 'reverted',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'FAILED')
  assert.equal(built.settlement.status, 'NOT_CONFIRMED')
  assert.equal(checkFor(built.checks, 'transaction-success')?.result, 'FAIL')
  assert.equal(checkFor(built.checks, 'settlement-confirmed')?.result, 'FAIL')
}
console.log('ok  reverted transaction -> execution FAILED, settlement NOT_CONFIRMED')

// --- transaction not found -> UNKNOWN / UNVERIFIED, never fabricated CONFIRMED ---

{
  const observation: SettlementObservation = {
    state: 'not-found',
    blockNumber: null,
    blockTimestamp: null,
    confirmations: null,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'UNKNOWN')
  assert.equal(built.settlement.status, 'UNVERIFIED')
  assert.notEqual(built.settlement.status, 'CONFIRMED')
  assert.equal(checkFor(built.checks, 'transaction-found')?.result, 'FAIL')
}
console.log('ok  transaction not found -> UNKNOWN/UNVERIFIED, never fabricated CONFIRMED')

// --- RPC unavailable -> UNKNOWN semantics, never fake CONFIRMED ----------

{
  const observation: SettlementObservation = {
    state: 'rpc-unavailable',
    blockNumber: null,
    blockTimestamp: null,
    confirmations: null,
    sufficientlyConfirmed: false,
    transfers: [],
    rpcError: 'connection refused',
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'UNKNOWN')
  assert.equal(built.settlement.status, 'UNVERIFIED')
  assert.equal(checkFor(built.checks, 'transaction-found')?.result, 'UNKNOWN')
}
console.log('ok  RPC unavailable -> UNKNOWN/UNVERIFIED, never fake CONFIRMED')

// --- confirmed but no matching transfer at all -> settlement NOT_CONFIRMED, execution CONFIRMED ---

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [], // tx succeeded but never touched the expected asset contract
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'CONFIRMED', 'the transaction itself did confirm')
  assert.equal(built.settlement.status, 'NOT_CONFIRMED', 'but the specific proposed payment did not settle')
  assert.equal(checkFor(built.checks, 'asset-matches-preflight')?.result, 'FAIL')
}
console.log('ok  transaction confirmed but no matching transfer -> execution CONFIRMED, settlement NOT_CONFIRMED')

// --- D2.2B2: recipient mismatch -- a REAL settlement still occurred, just
// not the one preflighted. settlement.status must be CONFIRMED (a supported
// Base USDC transfer genuinely settled); execution-matches-preflight must be
// FAIL (it settled the wrong thing). These are independent dimensions --
// see this file's header and commerceReceipt.ts's. ------------------------

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: SENDER, to: OTHER_RECIPIENT, amountAtomic: 2_000_000n }],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'CONFIRMED', 'the transaction itself did confirm')
  assert.equal(checkFor(built.checks, 'recipient-matches-preflight')?.result, 'FAIL')
  assert.equal(checkFor(built.checks, 'amount-matches-preflight')?.result, 'FAIL')
  assert.equal(checkFor(built.checks, 'execution-matches-preflight')?.result, 'FAIL')
  assert.equal(built.settlement.status, 'CONFIRMED', 'a real supported-asset transfer settled, even though it was not the one preflighted')
  assert.equal(checkFor(built.checks, 'settlement-confirmed')?.result, 'PASS')
  // The receipt must PRESERVE what was actually observed, not hide it.
  assert.equal(built.action.recipient, OTHER_RECIPIENT, 'observed (wrong) recipient must be visible in the receipt, not suppressed')
  assert.equal(built.action.amount, '2', 'observed (wrong) amount must be visible in the receipt, not suppressed')
}
console.log('ok  successful wrong recipient+amount -> execution CONFIRMED, settlement CONFIRMED, match checks FAIL, observed facts preserved')

// --- D2.2B2: right recipient, wrong amount only -> same independence -----

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 2_000_000n }], // preflight asked for 1.00 (1_000_000n)
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.execution.status, 'CONFIRMED')
  assert.equal(checkFor(built.checks, 'recipient-matches-preflight')?.result, 'PASS')
  assert.equal(checkFor(built.checks, 'amount-matches-preflight')?.result, 'FAIL')
  assert.equal(checkFor(built.checks, 'execution-matches-preflight')?.result, 'FAIL')
  assert.equal(built.settlement.status, 'CONFIRMED', 'the right recipient still received a real settled USDC transfer, just the wrong amount')
}
console.log('ok  successful wrong amount only (right recipient) -> execution CONFIRMED, settlement CONFIRMED, amount/execution match FAIL')

// --- sender required and mismatched: same independence -------------------

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: OTHER_RECIPIENT, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  const pf = preflightReceipt({ sender: SENDER })
  const built = buildCommerceReceiptCore(pf, EXECUTION, observation)
  assert.equal(checkFor(built.checks, 'sender-matches-preflight')?.result, 'FAIL')
  assert.equal(checkFor(built.checks, 'execution-matches-preflight')?.result, 'FAIL')
  assert.equal(built.settlement.status, 'CONFIRMED', 'a real supported-asset transfer settled, even from the wrong sender')
}
console.log('ok  required sender mismatch -> execution-matches-preflight FAIL, settlement still CONFIRMED')

// --- confirmed but not enough confirmations yet -> UNKNOWN, not fabricated ---

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 0,
    sufficientlyConfirmed: false,
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(preflightReceipt(), EXECUTION, observation)
  assert.equal(built.settlement.status, 'UNVERIFIED')
  assert.equal(checkFor(built.checks, 'settlement-confirmed')?.result, 'UNKNOWN')
}
console.log('ok  insufficient confirmations -> settlement UNVERIFIED, never fabricated CONFIRMED')

// --- decision is copied verbatim, never re-evaluated ---------------------

{
  const pf = preflightReceipt()
  pf.decision = { status: 'REQUIRE_APPROVAL', authorized: false, reasons: ['some reason'] }
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  buildCommerceReceiptCore(pf, EXECUTION, observation)
  // buildCommerceReceiptCore does not touch `decision` itself -- the caller
  // (finalizeRoute.ts) copies preflightReceipt.decision verbatim. Assert the
  // limitations text says so, so this contract stays visible in the receipt.
  const built = buildCommerceReceiptCore(pf, EXECUTION, observation)
  assert.ok(built.limitations.some((l) => /copied unchanged from the original PREFLIGHT receipt/.test(l)))
}
console.log('ok  limitations disclose that decision is copied unchanged, never re-evaluated')

// --- result_digest labelled as caller-provided only ----------------------

{
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
    rpcError: null,
  }
  const execWithDigest: FinalizationExecutionInput = { ...EXECUTION, result_digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  const built = buildCommerceReceiptCore(preflightReceipt(), execWithDigest, observation)
  const check = checkFor(built.checks, 'service-delivery-verification')
  assert.equal(check?.result, 'NOT_CHECKED')
  assert.equal(check?.evidence_digest, execWithDigest.result_digest)
  assert.ok(/caller-provided/i.test(check!.summary))
  assert.ok(!/service delivered this result/i.test(check!.summary))
}
console.log('ok  result_digest recorded as a caller-provided claim only, never as verified delivery')

// --- preflight amount precision exceeds asset decimals -> never silently rounded/matched ---

{
  const pf = preflightReceipt({ amount: '1.1234567' }) // USDC has 6 decimals, this has 7
  const observation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-04T00:01:00.000Z',
    confirmations: 5,
    sufficientlyConfirmed: true,
    // Even the "closest possible" on-chain value must not be treated as a match.
    transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_123_457n }],
    rpcError: null,
  }
  const built = buildCommerceReceiptCore(pf, EXECUTION, observation)
  assert.equal(checkFor(built.checks, 'amount-matches-preflight')?.result, 'FAIL', 'over-precise preflight amounts must never be silently rounded into a match')
  // D2.2B2: a real USDC transfer still settled (just not the exact
  // over-precise amount asked for) -- settlement.status reports that a
  // supported settlement occurred; it is amount-matches-preflight's job,
  // not settlement.status's, to say it wasn't the requested amount.
  assert.equal(built.settlement.status, 'CONFIRMED')
}
console.log('ok  preflight amount with more precision than the asset supports never silently matches (no rounding)')

console.log('\nAll D2.2 Commerce Receipt construction tests passed.')
