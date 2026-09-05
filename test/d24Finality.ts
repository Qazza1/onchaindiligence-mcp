/** D2.4 (Section 9, acceptance criterion #11, Section 15 test #8): named,
 * versioned finality policy for the commerce-lifecycle profile.
 *
 * Run with: npx tsx test/d24Finality.ts
 *
 * Fully offline: injects a fake MinimalFinalityClient -- no real RPC.
 */
import assert from 'node:assert/strict'
import { evaluateBaseFinality, BASE_FINALITY_POLICY, type MinimalFinalityClient } from '../src/finality.js'

const SELECTED_BLOCK_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const SAFE_BLOCK_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`

// --- selected block is at/behind the safe head -> 'safe' ------------------

{
  const client: MinimalFinalityClient = {
    getBlock: async () => ({ number: 200n, hash: SAFE_BLOCK_HASH }),
  }
  const result = await evaluateBaseFinality(client, 150n, SELECTED_BLOCK_HASH)
  assert.equal(result.policy, BASE_FINALITY_POLICY)
  assert.equal(result.state, 'safe')
  assert.equal(result.chainHeadUsed?.tag, 'safe')
  assert.equal(result.chainHeadUsed?.number, '200')
  assert.equal(result.selectedBlock.number, '150')
}
console.log('ok  a selected block at or behind the safe head evaluates to state "safe", with the chain head used recorded')

// --- Section 15 test #8: selected block AHEAD of the safe head -> never qualifies as safe ---

{
  const client: MinimalFinalityClient = {
    getBlock: async () => ({ number: 100n, hash: SAFE_BLOCK_HASH }),
  }
  const result = await evaluateBaseFinality(client, 150n, SELECTED_BLOCK_HASH)
  assert.equal(result.state, 'pending', 'a block ahead of the safe head must never be reported as safe')
  assert.notEqual(result.state, 'safe')
}
console.log('ok  a selected block ahead of the safe head is "pending", never fabricated as "safe"')

// --- Section 15 test #8: RPC does not support the safe tag -> honest "unverifiable", never a silent fallback ---

{
  const client: MinimalFinalityClient = {
    getBlock: async () => {
      throw new Error('the method eth_getBlockByNumber does not exist/is not available')
    },
  }
  const result = await evaluateBaseFinality(client, 150n, SELECTED_BLOCK_HASH)
  assert.equal(result.policy, BASE_FINALITY_POLICY, 'the policy name must not change even when it cannot be evaluated')
  assert.equal(result.state, 'unverifiable')
  assert.equal(result.chainHeadUsed, null, 'no chain head was actually used -- never fabricate one')
}
console.log('ok  an RPC that cannot answer the safe-head query reports "unverifiable" honestly, never silently substituting a different evidentiary basis under the same policy name')

console.log('\nAll D2.4 finality-policy tests passed.')
