/** D4.0 conformance gate for the four signed consequential-action artifact families. */
import assert from 'node:assert/strict'

process.env.ATTESTATION_SERVICE_TOKEN = 'd40-test-token-not-a-production-secret'
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body)) as { evidence: unknown; purpose: string }
  return new Response(JSON.stringify({
    data: request.evidence,
    attestation: { signed: true, purpose: request.purpose, signature: 'test-signature' },
  }), { status: 200 })
}) as typeof fetch

const { contentId } = await import('../src/receipts.js')
const { signAllowancePreflight, signAllowanceObservation } = await import('../src/allowanceEvidence.js')
const { signSwapPreflight, signSwapObservation } = await import('../src/swapEvidence.js')
const { signBridgePreflight, signBridgeObservation } = await import('../src/bridgeEvidence.js')
const { signStakingPreflight, signStakingObservation } = await import('../src/stakingEvidence.js')
const { parseAllowanceInput, evaluateAllowancePolicy } = await import('../src/allowance.js')
const { parseSwapInput, evaluateSwapPolicy, BASE_WETH, UNISWAP_V3_SWAP_ROUTER02_BASE } = await import('../src/swap.js')
const { parseBridgeInput, evaluateBridgePolicy } = await import('../src/bridge.js')
const { parseStakingInput, evaluateStakingPolicy, ETH_NATIVE_ASSET, LIDO_STETH_SUBMIT_PROTOCOL } = await import('../src/staking.js')
const HASH = `0x${'1'.repeat(64)}`
const OWNER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

function assertPortableArtifact(name: string, envelope: any, expectedType: 'PREFLIGHT' | 'OBSERVATION') {
  const data = envelope.data
  assert.equal(envelope.attestation.signed, true, `${name}: attestation must be requested`)
  assert.equal(data.artifact_type, expectedType, `${name}: artifact type`)
  assert.equal(typeof data.schema, 'string', `${name}: schema disclosure`)
  assert.equal(typeof data.operation_id, 'string', `${name}: operation provenance`)
  assert.ok(Array.isArray(data.limitations) && data.limitations.length > 0, `${name}: limitations required`)
  const { artifact_digest, ...unsigned } = data
  assert.equal(artifact_digest, contentId(unsigned), `${name}: digest binds disclosed artifact content`)
}

const allowanceInput = parseAllowanceInput({ action: { kind: 'ERC20_ALLOWANCE', network: 'eip155:8453', token: BASE_USDC, owner: OWNER, spender: RECIPIENT, amount_atomic: '1000000', intent: 'SET_ALLOWANCE' }, policy: { allowed_networks: ['eip155:8453'], allowed_tokens: [BASE_USDC], allowed_spenders: [RECIPIENT], max_allowance_atomic: '1000000' } })
const allowanceEvaluation = evaluateAllowancePolicy(allowanceInput)
const allowancePreflight = await signAllowancePreflight({ action: allowanceInput.action, policy: allowanceInput.policy, decision: allowanceEvaluation.decision, checks: allowanceEvaluation.checks, pre_action_state: { state: 'UNRESOLVED', reason: 'test fixture' }, operation_id: 'd40-allowance', created_at: '2026-01-01T00:00:00.000Z' })
const allowanceObservation = await signAllowanceObservation(allowancePreflight.data, { state: 'rpc-unavailable', network: 'eip155:8453', token: BASE_USDC, transaction_hash: HASH, block_number: null, block_hash: null, block_timestamp: null, approvals: [], finality: null, post_state: null, rpc_error: 'test fixture' } as any)
const swapInput = parseSwapInput({ action: { kind: 'SWAP', network: 'eip155:8453', input_asset: BASE_USDC, max_input_atomic: '1000000', output_asset: BASE_WETH, min_output_atomic: '1', recipient: RECIPIENT, router: UNISWAP_V3_SWAP_ROUTER02_BASE, deadline: null, payer: OWNER }, policy: { allowed_networks: ['eip155:8453'], allowed_input_assets: [BASE_USDC], allowed_output_assets: [BASE_WETH], allowed_routers: [UNISWAP_V3_SWAP_ROUTER02_BASE], max_input_atomic: '1000000', min_output_atomic: '1', exact_recipient: RECIPIENT } })
const swapEvaluation = evaluateSwapPolicy(swapInput)
const swapPreflight = await signSwapPreflight({ action: swapInput.action, policy: swapInput.policy, decision: swapEvaluation.decision, checks: swapEvaluation.checks, operation_id: 'd40-swap', created_at: '2026-01-01T00:00:00.000Z' })
const swapObservation = await signSwapObservation(swapPreflight.data, { state: 'rpc-unavailable', network: 'eip155:8453', transaction_hash: HASH, router: null, payer: null, decoded_parameters: null, input_transfer: null, output_transfer: null, block_number: null, block_hash: null, finality: null, rpc_error: 'test fixture' } as any)
const bridgeInput = parseBridgeInput({ action: { kind: 'BRIDGE', protocol: 'circle-cctp-v2', source_network: 'eip155:8453', destination_network: 'eip155:1', source_asset: BASE_USDC, destination_asset: ETH_USDC, max_source_atomic: '1000000', min_destination_atomic: '1000000', recipient: RECIPIENT }, policy: { allowed_source_networks: ['eip155:8453'], allowed_destination_networks: ['eip155:1'] } })
const bridgeEvaluation = evaluateBridgePolicy(bridgeInput)
const bridgePreflight = await signBridgePreflight({ action: bridgeInput.action, policy: bridgeInput.policy, decision: bridgeEvaluation.decision, checks: bridgeEvaluation.checks, operation_id: 'd40-bridge', created_at: '2026-01-01T00:00:00.000Z' })
const bridgeObservation = await signBridgeObservation(bridgePreflight.data, null, null)
const stakingInput = parseStakingInput({ action: { kind: 'STAKE', protocol: LIDO_STETH_SUBMIT_PROTOCOL, network: 'eip155:1', input_asset: ETH_NATIVE_ASSET, staker: OWNER, max_amount_wei: '100000000000000000' }, policy: { allowed_networks: ['eip155:1'], allowed_protocols: [LIDO_STETH_SUBMIT_PROTOCOL], exact_staker: OWNER, max_amount_wei: '100000000000000000' } })
const stakingEvaluation = evaluateStakingPolicy(stakingInput)
const stakingPreflight = await signStakingPreflight({ action: stakingInput.action, policy: stakingInput.policy, decision: stakingEvaluation.decision, checks: stakingEvaluation.checks, operation_id: 'd40-staking', created_at: '2026-01-01T00:00:00.000Z' })
const stakingObservation = await signStakingObservation(stakingPreflight.data, { state: 'rpc-unavailable', network: 'eip155:1', transaction_hash: HASH, block_number: null, block_hash: null, log_index: null, contract: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', transaction_from: null, transaction_to: null, transaction_value_wei: null, submitted_sender: null, submitted_amount_wei: null, referral: null, shares_minted: null, finality: null, rpc_error: 'test fixture' } as any)

for (const [name, artifact, type] of [
  ['allowance preflight', allowancePreflight, 'PREFLIGHT'], ['allowance observation', allowanceObservation, 'OBSERVATION'],
  ['swap preflight', swapPreflight, 'PREFLIGHT'], ['swap observation', swapObservation, 'OBSERVATION'],
  ['bridge preflight', bridgePreflight, 'PREFLIGHT'], ['bridge observation', bridgeObservation, 'OBSERVATION'],
  ['staking preflight', stakingPreflight, 'PREFLIGHT'], ['staking observation', stakingObservation, 'OBSERVATION'],
] as const) assertPortableArtifact(name, artifact, type)

for (const [name, artifact] of [
  ['allowance', allowancePreflight], ['swap', swapPreflight], ['bridge', bridgePreflight], ['staking', stakingPreflight],
] as const) {
  assert.ok(artifact.data.limitations.some((item: string) => /wallet authority/i.test(item)), `${name}: policy limitation must be explicit`)
}
assert.ok('pre_action_state' in allowancePreflight.data, 'allowance preflight distinguishes point-in-time state from execution evidence')
assert.ok('selected_approval' in allowanceObservation.data && 'findings' in allowanceObservation.data, 'allowance observation discloses selection and reconciliation provenance')
assert.ok('observation' in swapObservation.data && 'findings' in swapObservation.data, 'swap observation discloses chain observation and findings')
assert.ok('source_observed' in bridgeObservation.data && 'destination_observed' in bridgeObservation.data && 'reconciliation' in bridgeObservation.data, 'bridge observation separates each chain and reconciliation')
assert.ok('observed' in stakingObservation.data && 'reconciliation' in stakingObservation.data, 'staking observation discloses observed evidence and reconciliation')
for (const artifact of [allowanceObservation, swapObservation, bridgeObservation]) {
  assert.ok(artifact.data.limitations.some((item: string) => /binding/i.test(item)), 'non-payment action must disclose binding vocabulary limits')
}
console.log('ok  allowance, swap, bridge, and staking artifacts retain required provenance, digest, and limitation disclosures')
