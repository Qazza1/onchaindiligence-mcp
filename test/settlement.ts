/** D2.2B2 tests for src/settlement.ts's chain-observation robustness.
 *
 * Run with: npx tsx test/settlement.ts
 *
 * Fully offline: a MinimalSettlementClient fake is injected via
 * observeTransaction()'s deps param — no real viem client, no real RPC call.
 * Covers the exact regression this task fixes: a transaction receipt that
 * resolves fine while the block/confirmations lookup transiently fails
 * ("Block at number ... could not be found").
 */
import assert from 'node:assert/strict'
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem'
import { observeTransaction, type MinimalSettlementClient } from '../src/settlement.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const NETWORK = 'eip155:8453'
const SENDER = '0x2222222222222222222222222222222222222222'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const BLOCK_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

function transferLog(from: string, to: string, amount: bigint) {
  const topics = encodeEventTopics({ abi: TRANSFER_ABI, eventName: 'Transfer', args: { from: from as `0x${string}`, to: to as `0x${string}` } })
  const data = encodeAbiParameters([{ type: 'uint256' }], [amount])
  return { address: USDC as `0x${string}`, topics, data } as any
}

function fakeReceipt(overrides: Partial<{ status: 'success' | 'reverted'; logs: unknown[] }> = {}) {
  return {
    status: overrides.status ?? 'success',
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    logs: overrides.logs ?? [transferLog(SENDER, RECIPIENT, 1_000_000n)],
  }
}

// --- bounded retry: transient block-metadata race resolves within the attempt budget ---

{
  let blockCalls = 0
  const client: MinimalSettlementClient = {
    getTransactionReceipt: async () => fakeReceipt(),
    getBlockNumber: async () => 104n,
    getBlock: async () => {
      blockCalls++
      if (blockCalls < 3) throw new Error('Block at number "104" could not be found.')
      return { timestamp: 1_700_000_000n }
    },
  }
  const observation = await observeTransaction(TX_HASH, NETWORK, USDC, { client })
  assert.equal(observation.state, 'success')
  assert.equal(observation.sufficientlyConfirmed, true)
  assert.equal(observation.confirmations, 5)
  assert.equal(observation.transfers.length, 1)
  assert.ok(blockCalls >= 3, 'must actually have retried past the transient failures')
}
console.log('ok  transient block-metadata race resolves via bounded retry -- success, sufficiently confirmed, transfers preserved')

// --- RPC still unavailable after every retry: evidence already observed is NOT thrown away ---

{
  let blockCalls = 0
  const client: MinimalSettlementClient = {
    getTransactionReceipt: async () => fakeReceipt(),
    getBlockNumber: async () => {
      blockCalls++
      throw new Error('Block at number "50883116" could not be found.')
    },
    getBlock: async () => {
      throw new Error('Block at number "50883116" could not be found.')
    },
  }
  const observation = await observeTransaction(TX_HASH, NETWORK, USDC, { client })
  // Still retryable ("success" + not sufficiently confirmed), NEVER
  // fabricated as confirmed, and NEVER downgraded to throwing away the
  // already-observed receipt status/transfers.
  assert.equal(observation.state, 'success')
  assert.equal(observation.sufficientlyConfirmed, false)
  assert.equal(observation.confirmations, null)
  assert.equal(observation.transfers.length, 1, 'transfers decoded from the receipt logs must survive a block-lookup failure')
  assert.equal(observation.transfers[0]?.to.toLowerCase(), RECIPIENT.toLowerCase())
  assert.ok(observation.rpcError, 'the RPC failure reason should be recorded for diagnostics')
  assert.ok(blockCalls >= 3 && blockCalls <= 5, 'bounded retry: a handful of attempts, not unbounded')
}
console.log('ok  RPC still unavailable after bounded retry -- retryable "success" with confirmations unknown, evidence NOT discarded')

// --- a revert is definitive immediately -- no block/confirmation lookup needed ---

{
  let blockNumberCalled = false
  let getBlockCalled = false
  const client: MinimalSettlementClient = {
    getTransactionReceipt: async () => fakeReceipt({ status: 'reverted', logs: [] }),
    getBlockNumber: async () => {
      blockNumberCalled = true
      return 999n
    },
    getBlock: async () => {
      getBlockCalled = true
      return { timestamp: 0n }
    },
  }
  const observation = await observeTransaction(TX_HASH, NETWORK, USDC, { client })
  assert.equal(observation.state, 'reverted')
  assert.equal(blockNumberCalled, false, 'a revert is knowable from the receipt alone -- no confirmation lookup needed')
  assert.equal(getBlockCalled, false)
}
console.log('ok  reverted transaction is definitive immediately, without any block/confirmation RPC call')

// --- transaction not found: no retry, no block lookup attempted -----------

{
  let blockNumberCalled = false
  const client: MinimalSettlementClient = {
    getTransactionReceipt: async () => {
      const err: any = new Error('not found')
      err.name = 'TransactionReceiptNotFoundError'
      throw err
    },
    getBlockNumber: async () => {
      blockNumberCalled = true
      return 0n
    },
    getBlock: async () => ({ timestamp: 0n }),
  }
  const observation = await observeTransaction(TX_HASH, NETWORK, USDC, { client })
  assert.equal(observation.state, 'not-found')
  assert.equal(blockNumberCalled, false)
}
console.log('ok  transaction not found -> state "not-found", no block lookup attempted')

console.log('\nAll D2.2B2 settlement-robustness tests passed.')
