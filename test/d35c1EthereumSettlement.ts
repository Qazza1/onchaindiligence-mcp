/** Focused D3.5C1 Ethereum canonical-USDC observation tests. Fully offline. */
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { observeTransaction, getSupportedAsset, type MinimalSettlementClient } from '../src/settlement.js'
import { BASE_CAIP2, ETHEREUM_CAIP2, BASE_USDC, ETHEREUM_USDC } from '../src/settlementNetworks.js'
import { evaluateSettlementFinality } from '../src/finality.js'
import { deriveTaxonomyFindings } from '../src/contradictionTaxonomy.js'

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const BLOCK = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const PAYER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

function clientFor(asset: string, recipient = RECIPIENT, amount = 1_000_000n, finalized = 120n): MinimalSettlementClient {
  const topics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: 'Transfer', args: { from: PAYER as `0x${string}`, to: recipient as `0x${string}` } })
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount])
  return {
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, blockHash: BLOCK, logs: [{ address: asset, topics, data }] as any }),
    getBlockNumber: async () => 105n,
    getBlock: async (args: any) => args.blockTag === 'finalized'
      ? ({ number: finalized, hash: ('0x' + 'ef'.repeat(32)) as `0x${string}`, timestamp: 1_700_000_000n })
      : ({ timestamp: 1_700_000_000n }),
  }
}

// Mechanical Base extraction: registry/address and existing confirmation
// behavior remain intact.
assert.equal(getSupportedAsset(BASE_CAIP2, BASE_USDC)?.decimals, 6)
const baseObservation = await observeTransaction(TX, BASE_CAIP2, BASE_USDC, { client: clientFor(BASE_USDC) })
assert.equal(baseObservation.sufficientlyConfirmed, true)
console.log('ok  Base canonical USDC observation remains confirmation-count compatible after extraction')

// Ethereum canonical USDC is independently decoded and requires finalized.
assert.equal(getSupportedAsset(ETHEREUM_CAIP2, ETHEREUM_USDC)?.symbol, 'USDC')
const ethereumObservation = await observeTransaction(TX, ETHEREUM_CAIP2, ETHEREUM_USDC, { client: clientFor(ETHEREUM_USDC) })
assert.equal(ethereumObservation.state, 'success')
assert.equal(ethereumObservation.transfers[0]?.assetContract.toLowerCase(), ETHEREUM_USDC)
assert.equal(ethereumObservation.transfers[0]?.amountAtomic, 1_000_000n)
assert.equal(ethereumObservation.sufficientlyConfirmed, true)
const ethFinality = await evaluateSettlementFinality(ETHEREUM_CAIP2, clientFor(ETHEREUM_USDC) as any, 100n, BLOCK)
assert.equal(ethFinality.policy, 'ethereum-usdc-finalized-head.v1')
assert.equal(ethFinality.state, 'safe')
assert.equal(ethFinality.chainHeadUsed?.tag, 'finalized')
console.log('ok  Ethereum canonical USDC transfer is observed and confirmed only against finalized head')

const notFinalized = await observeTransaction(TX, ETHEREUM_CAIP2, ETHEREUM_USDC, { client: clientFor(ETHEREUM_USDC, RECIPIENT, 1_000_000n, 99n) })
assert.equal(notFinalized.state, 'success')
assert.equal(notFinalized.sufficientlyConfirmed, false, 'an Ethereum transaction ahead of finalized head must never be confirmed')
console.log('ok  Ethereum transaction before finalized head is never falsely confirmed')

const unavailableFinality = await evaluateSettlementFinality(ETHEREUM_CAIP2, { getBlock: async () => { throw new Error('finalized tag unavailable') } }, 100n, BLOCK)
assert.equal(unavailableFinality.policy, 'ethereum-usdc-finalized-head.v1')
assert.equal(unavailableFinality.state, 'unverifiable')
assert.equal(unavailableFinality.chainHeadUsed, null)
console.log('ok  unavailable Ethereum finalized head is unverifiable, never a confirmation-count fallback')

const mismatch = await observeTransaction(TX, ETHEREUM_CAIP2, ETHEREUM_USDC, { client: clientFor(ETHEREUM_USDC, OTHER, 1_000_001n) })
assert.equal(mismatch.transfers[0]?.to.toLowerCase(), OTHER.toLowerCase())
assert.equal(mismatch.transfers[0]?.amountAtomic, 1_000_001n)
const findings = deriveTaxonomyFindings({
  attribution: 'ATTRIBUTED', evidence_refs: [],
  mandate: { network: ETHEREUM_CAIP2, asset: ETHEREUM_USDC, recipient: RECIPIENT, amount_atomic: '1000000' },
  observation: { network: ETHEREUM_CAIP2, asset: ETHEREUM_USDC, recipient: OTHER, amount_atomic: '1000001' },
})
assert.ok(findings.some((finding) => finding.code === 'AMOUNT_MISMATCH'))
assert.ok(findings.some((finding) => finding.code === 'RECIPIENT_MISMATCH'))
const networkMismatch = deriveTaxonomyFindings({
  attribution: 'ATTRIBUTED', evidence_refs: [],
  mandate: { network: ETHEREUM_CAIP2 }, observation: { network: BASE_CAIP2 },
})
assert.ok(networkMismatch.some((finding) => finding.code === 'NETWORK_MISMATCH'))
console.log('ok  Ethereum observed mismatches and Base/Ethereum network disagreement use existing D3.3 findings')
