/** Focused D3.6D tests: strict policy, independent Lido log observation, reconciliation, and proof integrity. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { contentId, receiptAttestationSigningInput } from '../src/receipts.js'
import { evaluateStakingPolicy, ETH_NATIVE_ASSET, LIDO_STETH_PROXY, LIDO_STETH_SUBMIT_PROTOCOL, parseStakingInput, STAKING_ACTION_SCHEMA } from '../src/staking.js'
import { observeLidoStaking } from '../src/stakingObservation.js'
import { deriveStakingFindings, verifyStakingArtifact } from '../src/stakingEvidence.js'
import { inspectPayment } from '../src/preflight.js'

const STAKER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const REFERRAL = '0x3333333333333333333333333333333333333333'
const TX = `0x${'ab'.repeat(32)}` as const
const BLOCK = `0x${'cd'.repeat(32)}` as const
const AMOUNT = 100_000_000_000_000_000n
const ABI = parseAbi(['event Submitted(address indexed sender, uint256 amount, address referral)', 'event TransferShares(address indexed from, address indexed to, uint256 sharesValue)'])

function body(overrides: any = {}) {
  return {
    action: { kind: 'STAKE', protocol: LIDO_STETH_SUBMIT_PROTOCOL, network: 'eip155:1', input_asset: ETH_NATIVE_ASSET, staker: STAKER, max_amount_wei: AMOUNT.toString(), ...overrides.action },
    policy: { allowed_networks: ['eip155:1'], allowed_protocols: [LIDO_STETH_SUBMIT_PROTOCOL], exact_staker: STAKER, max_amount_wei: AMOUNT.toString(), ...overrides.policy },
  }
}
function submittedLog(sender = STAKER, amount = AMOUNT, referral = REFERRAL, logIndex = 3) {
  const topics = encodeEventTopics({ abi: ABI, eventName: 'Submitted', args: { sender: sender as `0x${string}` } })
  return { address: LIDO_STETH_PROXY, blockHash: BLOCK, transactionHash: TX, logIndex, topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [amount, referral as `0x${string}`]) } as any
}
function shareLog(to = STAKER, shares = AMOUNT, logIndex = 4) {
  const topics = encodeEventTopics({ abi: ABI, eventName: 'TransferShares', args: { from: '0x0000000000000000000000000000000000000000', to: to as `0x${string}` } })
  return { address: LIDO_STETH_PROXY, blockHash: BLOCK, transactionHash: TX, logIndex, topics, data: encodeAbiParameters([{ type: 'uint256' }], [shares]) } as any
}
const client = (logs: any[], tx: any = {}) => ({
  getTransactionReceipt: async () => ({ status: 'success' as const, blockNumber: 100n, blockHash: BLOCK, logs }),
  getTransaction: async () => ({ from: STAKER, to: LIDO_STETH_PROXY, value: AMOUNT, ...tx }),
  getBlock: async () => ({ number: 200n, hash: BLOCK }),
})

// 1 strict valid policy -> ALLOW; 2 wrong staker policy -> BLOCK
const parsed = parseStakingInput(body())
assert.equal(evaluateStakingPolicy(parsed).decision.status, 'ALLOW')
assert.equal(evaluateStakingPolicy(parseStakingInput(body({ policy: { exact_staker: OTHER } }))).decision.status, 'BLOCK')
console.log('ok strict policy allows matching staker and blocks a wrong exact staker')

// 3 matching finalized observation -> zero findings, including optional share corroboration
const observation = await observeLidoStaking(TX, { client: client([submittedLog(), shareLog()]) as any })
assert.equal(observation.state, 'success')
assert.equal(observation.finality?.state, 'safe')
assert.equal(observation.transaction_from?.toLowerCase(), observation.submitted_sender?.toLowerCase())
assert.equal(observation.transaction_value_wei, observation.submitted_amount_wei)
assert.equal(observation.shares_minted, AMOUNT.toString())
assert.equal(deriveStakingFindings(parsed.action, observation).length, 0)
console.log('ok finalized Lido Submitted sender/value cross-check reconciles cleanly; TransferShares is corroboration only')

// 4 wrong staker; 5 amount above ceiling; 6 absent/not-finalized -> insufficient evidence
const wrongStaker = await observeLidoStaking(TX, { client: client([submittedLog(OTHER), shareLog(OTHER)], { from: OTHER }) as any })
assert.ok(deriveStakingFindings(parsed.action, wrongStaker).some((finding) => finding.code === 'STAKER_MISMATCH'))
const tooLarge = await observeLidoStaking(TX, { client: client([submittedLog(STAKER, AMOUNT + 1n), shareLog(STAKER, AMOUNT + 1n)], { value: AMOUNT + 1n }) as any })
assert.ok(deriveStakingFindings(parsed.action, tooLarge).some((finding) => finding.code === 'AMOUNT_MISMATCH'))
const pending = await observeLidoStaking(TX, { client: { ...client([submittedLog()]), getBlock: async () => ({ number: 99n, hash: BLOCK }) } as any })
assert.equal(deriveStakingFindings(parsed.action, pending)[0].finding_class, 'INSUFFICIENT_EVIDENCE')
console.log('ok wrong staker and amount ceiling are contradictions; pending finality is an evidence gap')

// 7 internal Submitted sender/value mismatch cannot reconcile
const inconsistent = await observeLidoStaking(TX, { client: client([submittedLog(OTHER, AMOUNT)], { from: STAKER }) as any })
assert.equal(inconsistent.state, 'inconsistent-observation')
assert.equal(deriveStakingFindings(parsed.action, inconsistent)[0].finding_class, 'INSUFFICIENT_EVIDENCE')
console.log('ok inconsistent transaction and Submitted facts cannot reconcile')

// 8 artifact valid; 9 tamper -> INVALID. A local ephemeral test key and mocked public registry prove the verifier path without production credentials.
const pair = generateKeyPairSync('ed25519')
const keyId = 'ed25519-D36DTEST000001'
const issuedAt = '2026-01-01T00:00:00.000Z'
const core = { schema: STAKING_ACTION_SCHEMA, artifact_type: 'PREFLIGHT' as const, operation_id: 'OCD-STK-test', created_at: issuedAt, authorized: { action: parsed.action, policy: parsed.policy, decision: { status: 'ALLOW' as const, authorized: true, reasons: [] as string[] }, checks: [] as unknown[] }, limitations: [] as string[] }
const data = { ...core, artifact_digest: contentId(core) }
const signature = signEd25519(null, Buffer.from(receiptAttestationSigningInput(data, { issuer: 'https://api.onchaindiligence.com', purpose: 'staking-action', issuedAt, keyId })), pair.privateKey).toString('base64url')
const envelope: any = { data, attestation: { signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: 'https://api.onchaindiligence.com', purpose: 'staking-action', algorithm: 'ed25519', canonicalization: 'RFC8785', key_id: keyId, issued_at: issuedAt, signature } }
const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [{ key_id: keyId, public_key_pem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), status: 'active', valid_from: '2025-01-01T00:00:00.000Z', valid_until: null }] }), { status: 200 })) as typeof fetch
try {
  assert.equal((await verifyStakingArtifact(envelope)).state, 'VALID')
  assert.equal((await verifyStakingArtifact({ ...envelope, data: { ...envelope.data, authorized: { ...envelope.data.authorized, decision: { status: 'BLOCK' } } } })).state, 'INVALID')
} finally { globalThis.fetch = originalFetch }
console.log('ok valid signed staking artifact verifies and tampering is INVALID')

// 10 one lightweight existing-action regression
assert.equal((await inspectPayment({ action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '1', sender: null, recipient: OTHER }, policy: { max_amount: '1' } })).decision.status, 'ALLOW')
console.log('D3.6D staking tests passed')
