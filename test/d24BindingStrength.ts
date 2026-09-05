/** D2.4 Claim Model + Section 6/8 tests (Section 15 tests #4, #5, #6, #7).
 *
 * Run with: npx tsx test/d24BindingStrength.ts
 *
 * Fully offline: exercises pure functions only (deriveBindingStrength,
 * decodeErc3009Authorization, selectExactTransfer) -- no network, no DB.
 */
import assert from 'node:assert/strict'
import { encodeFunctionData, keccak256, toHex } from 'viem'
import { deriveBindingStrength } from '../src/commerceLifecycle.js'
import { decodeErc3009Authorization } from '../src/paymentAuthorization.js'
import { selectExactTransfer } from '../src/commerceObservation.js'
import type { ObservedTransfer } from '../src/settlement.js'

const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const SENDER = '0x000000000000000000000000000000000000dEaD'
const OTHER_SENDER = '0x1111111111111111111111111111111111111a'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TX_HASH = '0x' + 'ab'.repeat(32)
const BLOCK_HASH = '0x' + 'cd'.repeat(32)

// --- Section 15 test #4: an old/unrelated matching transfer never reaches PAYMENT_IDENTITY_LINKED ---

{
  const level = deriveBindingStrength({
    transferFieldsMatch: true, // fields match...
    executorCorrelated: false, // ...but there is no durable execution binding at all
    expectedPayer: null,
    observedAuthorizer: null,
  })
  assert.equal(level, 'TRANSFER_MATCH_ONLY', 'field similarity alone, with no execution binding, can never exceed TRANSFER_MATCH_ONLY')
}
{
  // Even WITH a binding, no expected_payer commitment means the strongest
  // reachable level is EXECUTOR_CORRELATED, never PAYMENT_IDENTITY_LINKED --
  // "never treat field similarity alone as proof of causality".
  const level = deriveBindingStrength({
    transferFieldsMatch: true,
    executorCorrelated: true,
    expectedPayer: null,
    observedAuthorizer: SENDER, // even if an authorizer WAS independently observed
  })
  assert.equal(level, 'EXECUTOR_CORRELATED', 'no expected_payer commitment was made -- an observed authorizer alone cannot satisfy it')
}
console.log('ok  an old/unrelated matching transfer (or one with no commitment) can never reach PAYMENT_IDENTITY_LINKED')

// --- Section 15 test #5: wrong authorization nonce/payment identity fails strong binding ---

{
  const level = deriveBindingStrength({
    transferFieldsMatch: true,
    executorCorrelated: true,
    expectedPayer: SENDER,
    observedAuthorizer: OTHER_SENDER, // decoded on-chain authorizer does NOT match the commitment
  })
  assert.equal(level, 'EXECUTOR_CORRELATED', 'a mismatched authorizer must cap binding strength below PAYMENT_IDENTITY_LINKED')
}
{
  // The one case that DOES reach the top level: correlated, matched fields,
  // AND the independently-decoded authorizer equals the frozen commitment.
  const level = deriveBindingStrength({
    transferFieldsMatch: true,
    executorCorrelated: true,
    expectedPayer: SENDER,
    observedAuthorizer: SENDER.toUpperCase(), // case-insensitive address match
  })
  assert.equal(level, 'PAYMENT_IDENTITY_LINKED')
}
console.log('ok  wrong authorization identity fails strong binding; a genuine match (case-insensitively) reaches PAYMENT_IDENTITY_LINKED')

// --- Section 15 test #6: wrong transaction/log event fails strong binding ---
// (modeled as transferFieldsMatch: false -- the selected event does not
// actually match what the preflight proposed, regardless of any binding)

{
  const level = deriveBindingStrength({
    transferFieldsMatch: false,
    executorCorrelated: true,
    expectedPayer: SENDER,
    observedAuthorizer: SENDER,
  })
  assert.equal(level, 'TRANSFER_MATCH_ONLY', 'a mismatched transfer/event must never be reported above TRANSFER_MATCH_ONLY, no matter what else lines up')
}
console.log('ok  a wrong transaction/log event caps binding strength regardless of correlation or authorization')

// --- ERC-3009 calldata decoding -------------------------------------------

const TRANSFER_WITH_AUTH_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

function fakeAuthCalldata(from: string, to: string, value: bigint, nonce: `0x${string}`) {
  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTH_ABI,
    functionName: 'transferWithAuthorization',
    args: [from as `0x${string}`, to as `0x${string}`, value, 0n, 9999999999n, nonce, 27, ('0x' + '11'.repeat(32)) as `0x${string}`, ('0x' + '22'.repeat(32)) as `0x${string}`],
  })
}

{
  const nonce = keccak256(toHex('test-nonce-1'))
  const calldata = fakeAuthCalldata(SENDER, RECIPIENT, 1_000_000n, nonce)
  const decoded = decodeErc3009Authorization(calldata)
  assert.ok(decoded, 'a genuine transferWithAuthorization call must decode')
  assert.equal(decoded!.authorizer.toLowerCase(), SENDER.toLowerCase())
  assert.equal(decoded!.nonce, nonce)
  assert.equal(decoded!.valueAtomic, 1_000_000n)
}
console.log('ok  a genuine ERC-3009 transferWithAuthorization call decodes authorizer + nonce exactly')

{
  // Unrecognized calldata (a different function entirely) must fail closed
  // to null, never a fabricated or partial identity.
  const garbage = ('0x' + 'deadbeef' + '00'.repeat(64)) as `0x${string}`
  assert.equal(decodeErc3009Authorization(garbage), null, 'unrecognized calldata must decode to null, never throw or fabricate')
}
console.log('ok  unrecognized calldata (different scheme/wrapper) decodes to null, never fabricated')

// --- Section 15 test #7: multiple matching logs handled deterministically ---

function transfer(overrides: Partial<ObservedTransfer>): ObservedTransfer {
  return {
    assetContract: USDC,
    from: SENDER,
    to: RECIPIENT,
    amountAtomic: 1_000_000n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 0,
    ...overrides,
  }
}

{
  // Two transfers to the SAME recipient at different log indices, in
  // out-of-order array position -- selection must be deterministic by log
  // index, never by amount ("largest transfer").
  const transfers = [transfer({ logIndex: 5, amountAtomic: 500_000n }), transfer({ logIndex: 2, amountAtomic: 9_000_000n })]
  const selected = selectExactTransfer(transfers, RECIPIENT)
  assert.equal(selected?.logIndex, 2, 'selection must be the LOWEST log index among recipient matches, never the largest amount')
}
{
  // No transfer matches the expected recipient at all -- falls through to
  // the lowest log index overall, still deterministic, never "largest".
  const transfers = [transfer({ to: OTHER_SENDER, logIndex: 7, amountAtomic: 9_000_000n }), transfer({ to: OTHER_SENDER, logIndex: 1, amountAtomic: 1n })]
  const selected = selectExactTransfer(transfers, RECIPIENT)
  assert.equal(selected?.logIndex, 1)
}
{
  assert.equal(selectExactTransfer([], RECIPIENT), null, 'no transfers of the expected asset -> null, not a fabricated selection')
}
console.log('ok  multiple matching logs select deterministically by log index, never by transfer amount')

console.log('\nAll D2.4 binding-strength/claim-model tests passed.')
