import assert from 'node:assert/strict'
import { parseAbi } from 'viem'
import { parseAllowanceInput, evaluateAllowancePolicy, UINT256_MAX } from '../src/allowance.js'
import { observeAllowanceApproval } from '../src/allowanceObservation.js'
import { deriveAllowanceFindings, selectMatchingApproval } from '../src/allowanceEvidence.js'
import { inspectPayment } from '../src/preflight.js'

const OWNER = '0x1111111111111111111111111111111111111111'
const SPENDER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TX = `0x${'ab'.repeat(32)}` as const
const BLOCK = `0x${'cd'.repeat(32)}` as const

const base = (overrides: any = {}) => ({
  action: { kind: 'ERC20_ALLOWANCE', network: 'eip155:8453', token: USDC, owner: OWNER, spender: SPENDER, amount_atomic: '100000000', intent: 'SET_ALLOWANCE', ...overrides.action },
  policy: { allowed_networks: ['eip155:8453'], allowed_tokens: [USDC], allowed_spenders: [SPENDER], max_allowance_atomic: '100000000', ...overrides.policy },
})

const action = parseAllowanceInput(base()).action
const evaluated = evaluateAllowancePolicy(parseAllowanceInput(base()))
assert.equal(evaluated.decision.status, 'ALLOW')

assert.equal(evaluateAllowancePolicy(parseAllowanceInput(base({ policy: { ...base().policy, unlimited_allowance: 'BLOCK' }, action: { ...base().action, amount_atomic: UINT256_MAX } }))).decision.status, 'BLOCK')
assert.equal(evaluateAllowancePolicy(parseAllowanceInput(base({ policy: { ...base().policy, max_allowance_atomic: null, exact_allowance_atomic: UINT256_MAX, unlimited_allowance: 'ALLOW' }, action: { ...base().action, amount_atomic: UINT256_MAX } }))).decision.status, 'ALLOW')
assert.equal(parseAllowanceInput(base({ action: { ...base().action, intent: 'REVOKE', amount_atomic: '0' } })).action.intent, 'REVOKE')

const approvalAbi = parseAbi(['event Approval(address indexed owner, address indexed spender, uint256 value)'])
const log = {
  address: USDC, blockHash: BLOCK, transactionHash: TX, logIndex: 0, data: `0x${BigInt(100000000).toString(16).padStart(64, '0')}`,
  topics: [
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    `0x${OWNER.slice(2).padStart(64, '0')}`, `0x${SPENDER.slice(2).padStart(64, '0')}`,
  ],
} as any
const observation = await observeAllowanceApproval(TX, { client: {
  getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, blockHash: BLOCK, logs: [log] }),
  getBlock: async (args: any) => 'blockTag' in args ? ({ number: 100n, hash: BLOCK }) : ({ number: 100n, hash: BLOCK, timestamp: 1n }),
  readContract: async () => 100000000n,
} })
assert.equal(observation.finality?.state, 'safe')
assert.equal(observation.approvals[0].value_atomic, '100000000')
assert.equal(deriveAllowanceFindings(action, observation, selectMatchingApproval(action, observation)).length, 0)

const spenderMismatch = { ...observation, approvals: [{ ...observation.approvals[0], spender: OTHER }] }
assert.equal(deriveAllowanceFindings(action, spenderMismatch, selectMatchingApproval(action, spenderMismatch))[0].code, 'SPENDER_MISMATCH')
const allowanceMismatch = { ...observation, approvals: [{ ...observation.approvals[0], value_atomic: '1' }] }
assert.equal(deriveAllowanceFindings(action, allowanceMismatch, selectMatchingApproval(action, allowanceMismatch))[0].code, 'ALLOWANCE_MISMATCH')
assert.equal(deriveAllowanceFindings(action, { ...observation, finality: { ...observation.finality!, state: 'pending' } }, null)[0].finding_class, 'INSUFFICIENT_EVIDENCE')

// PAYMENT is still parsed/evaluated by its established code path.
assert.equal((await inspectPayment({ action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '1', sender: null, recipient: SPENDER }, policy: { max_amount: '1' } })).decision.status, 'ALLOW')
console.log('D3.6A allowance tests passed')
