/** Focused D3.5C2 Tempo mainnet pathUSD observation tests. Fully offline. */
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { observeTransaction, getSupportedAsset, type MinimalSettlementClient } from '../src/settlement.js'
import { BASE_CAIP2, ETHEREUM_CAIP2, TEMPO_CAIP2, BASE_USDC, ETHEREUM_USDC, TEMPO_PATH_USD } from '../src/settlementNetworks.js'
import { evaluateSettlementFinality } from '../src/finality.js'
import { deriveTaxonomyFindings } from '../src/contradictionTaxonomy.js'

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const BLOCK = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const FINALIZED_BLOCK = ('0x' + 'ef'.repeat(32)) as `0x${string}`
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
      ? ({ number: finalized, hash: FINALIZED_BLOCK, timestamp: 1_700_000_000n })
      : ({ timestamp: 1_700_000_000n }),
  }
}

// Existing networks remain unchanged by the additive registry entry.
assert.equal(getSupportedAsset(BASE_CAIP2, BASE_USDC)?.symbol, 'USDC')
assert.equal(getSupportedAsset(ETHEREUM_CAIP2, ETHEREUM_USDC)?.symbol, 'USDC')
console.log('ok  Base and Ethereum canonical-USDC registry entries remain available')

assert.deepEqual(getSupportedAsset(TEMPO_CAIP2, TEMPO_PATH_USD), { decimals: 6, symbol: 'pathUSD' })
const tempoObservation = await observeTransaction(TX, TEMPO_CAIP2, TEMPO_PATH_USD, { client: clientFor(TEMPO_PATH_USD) })
assert.equal(tempoObservation.state, 'success')
assert.equal(tempoObservation.transfers[0]?.assetContract.toLowerCase(), TEMPO_PATH_USD)
assert.equal(tempoObservation.transfers[0]?.from.toLowerCase(), PAYER.toLowerCase())
assert.equal(tempoObservation.transfers[0]?.to.toLowerCase(), RECIPIENT.toLowerCase())
assert.equal(tempoObservation.transfers[0]?.amountAtomic, 1_000_000n)
assert.equal(tempoObservation.sufficientlyConfirmed, true)
const tempoFinality = await evaluateSettlementFinality(TEMPO_CAIP2, clientFor(TEMPO_PATH_USD) as any, 100n, BLOCK)
assert.equal(tempoFinality.policy, 'tempo-tip20-finalized-head.v1')
assert.equal(tempoFinality.state, 'safe')
assert.equal(tempoFinality.chainHeadUsed?.tag, 'finalized')
console.log('ok  Tempo pathUSD Transfer is decoded and confirmed only against the finalized head')

const notFinalized = await observeTransaction(TX, TEMPO_CAIP2, TEMPO_PATH_USD, { client: clientFor(TEMPO_PATH_USD, RECIPIENT, 1_000_000n, 99n) })
assert.equal(notFinalized.state, 'success')
assert.equal(notFinalized.sufficientlyConfirmed, false)
const unavailableFinality = await evaluateSettlementFinality(TEMPO_CAIP2, { getBlock: async () => { throw new Error('finalized tag unavailable') } }, 100n, BLOCK)
assert.equal(unavailableFinality.state, 'unverifiable')
console.log('ok  Tempo inclusion before finalized head is not confirmed; unavailable finality remains unverifiable')

const mismatch = await observeTransaction(TX, TEMPO_CAIP2, TEMPO_PATH_USD, { client: clientFor(TEMPO_PATH_USD, OTHER, 1_000_001n) })
const findings = deriveTaxonomyFindings({
  attribution: 'ATTRIBUTED', evidence_refs: [],
  mandate: { network: TEMPO_CAIP2, asset: TEMPO_PATH_USD, recipient: RECIPIENT, amount_atomic: '1000000' },
  observation: { network: TEMPO_CAIP2, asset: TEMPO_PATH_USD, recipient: mismatch.transfers[0]?.to, amount_atomic: mismatch.transfers[0]?.amountAtomic.toString() },
})
assert.ok(findings.some((finding) => finding.code === 'AMOUNT_MISMATCH'))
assert.ok(findings.some((finding) => finding.code === 'RECIPIENT_MISMATCH'))
const networkMismatch = deriveTaxonomyFindings({
  attribution: 'ATTRIBUTED', evidence_refs: [],
  mandate: { network: TEMPO_CAIP2 }, observation: { network: ETHEREUM_CAIP2 },
})
assert.ok(networkMismatch.some((finding) => finding.code === 'NETWORK_MISMATCH'))
console.log('ok  Tempo mismatches reuse the existing D3.3 taxonomy without new codes')
