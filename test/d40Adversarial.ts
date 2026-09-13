/** D4.0 false-pass adversarial harness. Fully offline; no RPC, keys, or DB. */
import assert from 'node:assert/strict'
import { MALFORMED_UPSTREAM_RESPONSES, assertConservative } from './fixtures/adversarialResponses.js'

process.env.ATTESTATION_SERVICE_TOKEN = 'd40-test-token-not-a-production-secret'

const { CanonicalVerdictError, canonicalVerdict } = await import('../src/attest.js')
const {
  parseProviderEvidenceInput,
  parseTurnkeyWebhookEvidenceInput,
  parseCrossmintWebhookEvidenceInput,
  parseCircleWebhookEvidenceInput,
  ProviderEvidenceInputError,
} = await import('../src/providerEvidence.js')
const { observeTransaction } = await import('../src/settlement.js')
const { observeSolanaTransaction, SOLANA_CAIP2, SOLANA_USDC_MINT } = await import('../src/solanaSettlement.js')
const { observeAllowanceApproval } = await import('../src/allowanceObservation.js')
const { observeSwap } = await import('../src/swapObservation.js')
const { observeBridgeSource } = await import('../src/bridgeObservation.js')
const { observeLidoStaking } = await import('../src/stakingObservation.js')

const HASH = `0x${'1'.repeat(64)}`
const SOLANA_SIGNATURE = '5'.repeat(64)
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

for (const [name, body] of MALFORMED_UPSTREAM_RESPONSES) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
  await assert.rejects(() => canonicalVerdict('0x000000000000000000000000000000000000dEaD'), CanonicalVerdictError, `canonical verdict: ${name}`)
}
console.log('ok  malformed 200 canonical-verdict responses are rejected, never PASS/WARN/BLOCK')

for (const [name, body] of MALFORMED_UPSTREAM_RESPONSES) {
  for (const [adapter, parse] of [
    ['x402', () => parseProviderEvidenceInput(body)],
    ['turnkey', () => parseTurnkeyWebhookEvidenceInput(body, 'evt-d40')],
    ['crossmint', () => parseCrossmintWebhookEvidenceInput(body, 'svix-d40')],
    ['circle', () => parseCircleWebhookEvidenceInput(body)],
  ] as const) {
    assert.throws(parse, ProviderEvidenceInputError, `${adapter}: ${name}`)
  }
}
console.log('ok  x402, Turnkey, Crossmint, and Circle malformed provider claims are rejected before normalization')

for (const [name, malformed] of MALFORMED_UPSTREAM_RESPONSES) {
  const evmClient = { getTransactionReceipt: async () => malformed } as any
  await assertConservative(`EVM settlement ${name}`, () => observeTransaction(HASH, 'eip155:8453', BASE_USDC, { client: evmClient }), (value) => value.state === 'success' && value.sufficientlyConfirmed)
  await assertConservative(`allowance ${name}`, () => observeAllowanceApproval(HASH, { client: evmClient }), (value) => value.state === 'success' && value.finality?.state === 'safe' && value.approvals.length > 0)
  await assertConservative(`swap ${name}`, () => observeSwap(HASH, { client: { ...evmClient, getTransaction: async () => malformed } }), (value) => value.state === 'success' && value.finality?.state === 'safe')
  await assertConservative(`bridge ${name}`, () => observeBridgeSource(HASH, { client: evmClient }), (value) => value.state === 'success' && value.finality?.state === 'safe')
  await assertConservative(`staking ${name}`, () => observeLidoStaking(HASH, { client: { ...evmClient, getTransaction: async () => malformed } }), (value) => value.state === 'success' && value.finality?.state === 'safe')
  await assertConservative(`Solana settlement ${name}`, () => observeSolanaTransaction(SOLANA_SIGNATURE, SOLANA_CAIP2, SOLANA_USDC_MINT, { client: { request: async () => malformed } }), (value) => value.state === 'success' && value.sufficientlyConfirmed)
}
console.log('ok  EVM, Solana, allowance, swap, bridge, and staking observers cannot turn malformed responses into finalized evidence')

// A provider may truthfully say it succeeded without a transaction hash. It
// remains a narrow provider claim, not settlement/confirmation evidence.
const incompleteClaim = parseProviderEvidenceInput({ x402_settle_response: { success: true } })
assert.equal(incompleteClaim.claimedState, 'SUCCEEDED')
assert.equal(incompleteClaim.transactionHash, null)
assert.equal(incompleteClaim.network, null)
console.log('ok  an incomplete provider success remains a provider claim and carries no fabricated settlement facts')
