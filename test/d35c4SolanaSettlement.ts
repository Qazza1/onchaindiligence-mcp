/**
 * D3.5C4 focused Solana canonical-USDC observation tests.
 *
 * Run with: npx tsx test/d35c4SolanaSettlement.ts
 * Every RPC response is injected; this file makes no network request.
 */
import assert from 'node:assert/strict'
import { observeSolanaTransaction, SOLANA_CAIP2, SOLANA_USDC_MINT, SPL_TOKEN_PROGRAM, type SolanaRpcClient } from '../src/solanaSettlement.js'
import { buildCommerceReceiptCore } from '../src/commerceReceipt.js'
import { finalizeReceiptCore, type Receipt, type ReceiptCoreFields } from '../src/receipts.js'
import { deriveTaxonomyFindings } from '../src/contradictionTaxonomy.js'
import { parsePreflightInput } from '../src/preflight.js'

const SIGNATURE = 'Pw5oYgXWaNaG2u8wAJeCiP87cYQWW6BiwFHZ9XG54ZhFh7whSKeEP4gQjzveKUFXZdEA8XNTirKs9JtopK9z7SP'
const SOURCE_ACCOUNT = 'EZYRnVGAx4ZSPCKo3wNjjJyLGF4R4bb7uoUUqETkord8'
const DESTINATION_ACCOUNT = '3nnVbsCfN1mwUk2XSLCnjzY3bDDTdzpnKjvRmd8nESS2'
const SOURCE_OWNER = '7xKAjaW9FTZWDZn7LkeGFxjV7cm16oDPMAACmqi28AFj'
const DESTINATION_OWNER = 'D5YqVMoSxnqeZAKAUUE1Dm3bmjtdxQ5DCF356ozqN9cM'
const SLOT = 442_515_573

const parsedSolanaAction = parsePreflightInput({
  action: { kind: 'PAYMENT', resource: null, network: SOLANA_CAIP2, asset: SOLANA_USDC_MINT, amount: '0.170555', sender: SOURCE_OWNER, recipient: DESTINATION_OWNER },
  policy: { allowed_networks: [SOLANA_CAIP2], allowed_assets: [SOLANA_USDC_MINT], expected_recipient: DESTINATION_OWNER, expected_payer: SOURCE_OWNER },
  options: {}, references: {}, publication: {},
})
assert.equal(parsedSolanaAction.action.recipient, DESTINATION_OWNER)
console.log('ok  Solana action and policy use native mint and wallet-address validation')

function rpc(finalizedSlot = SLOT, destinationOwner = DESTINATION_OWNER): SolanaRpcClient {
  return {
    async request(method, params) {
      if (method === 'getTransaction') {
        assert.equal(params[0], SIGNATURE)
        return {
          slot: SLOT,
          blockTime: 1_788_000_000,
          meta: {
            err: null,
            innerInstructions: [{
              // Matches the real historical transaction's canonical-USDC
              // inner instruction location (top-level 2, inner 7).
              index: 2,
              instructions: [...Array(7).fill({}), {
                programId: SPL_TOKEN_PROGRAM,
                parsed: { type: 'transferChecked', info: { source: SOURCE_ACCOUNT, destination: DESTINATION_ACCOUNT, mint: SOLANA_USDC_MINT, tokenAmount: { amount: '170555', decimals: 6 } } },
              }],
            }],
          },
          transaction: { message: { instructions: [{}, {}, {}] } },
        }
      }
      if (method === 'getAccountInfo') {
        const account = params[0]
        const owner = account === SOURCE_ACCOUNT ? SOURCE_OWNER : destinationOwner
        return { value: { owner: SPL_TOKEN_PROGRAM, data: { parsed: { info: { owner, mint: SOLANA_USDC_MINT } } } } }
      }
      if (method === 'getSlot') return finalizedSlot
      if (method === 'getBlock') return { blockhash: `solana-block-${String(params[0])}` }
      throw new Error(`unexpected RPC method ${method}`)
    },
  }
}

function preflight(recipient = DESTINATION_OWNER, amount = '0.170555'): Receipt {
  const core: ReceiptCoreFields = {
    receipt_type: 'PREFLIGHT', issued_at: '2026-09-11T00:00:00.000Z',
    action: { kind: 'PAYMENT', resource: null, network: SOLANA_CAIP2, asset: SOLANA_USDC_MINT, amount, sender: SOURCE_OWNER, recipient },
    decision: { status: 'ALLOW', authorized: true, reasons: ['test'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'test' }, checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null }, limitations: [],
  }
  return finalizeReceiptCore(core)
}

// 1 + 4. Canonical inner SPL transfer, including independently-resolved owners.
const matching = await observeSolanaTransaction(SIGNATURE, SOLANA_CAIP2, SOLANA_USDC_MINT, { client: rpc() })
assert.equal(matching.state, 'success')
assert.equal(matching.sufficientlyConfirmed, true)
assert.equal(matching.finality?.policy, 'solana-usdc-finalized.v1')
assert.equal(matching.finality?.state, 'safe')
assert.equal(matching.transfers.length, 1)
assert.deepEqual(matching.transfers[0], {
  assetContract: SOLANA_USDC_MINT, from: SOURCE_OWNER, to: DESTINATION_OWNER, amountAtomic: 170555n,
  blockHash: `solana-block-${SLOT}`, transactionHash: SIGNATURE, logIndex: 2008,
  sourceAccount: SOURCE_ACCOUNT, destinationAccount: DESTINATION_ACCOUNT, instructionIndex: 2, innerInstructionIndex: 7,
})
console.log('ok  finalized canonical USDC inner transfer resolves token-account owners')

// 2. Existing receipt/reconciliation boundary reports an amount/recipient mismatch; no Solana-specific finding is needed.
const mismatch = buildCommerceReceiptCore(preflight('8GHEeLKAXHHiQjRBq57u9atZKD6wwbGrmptmfMVsVoxK', '0.170556'), {
  transaction_hash: SIGNATURE, execution_provider: 'other', provider_reference: null, result_digest: null,
}, matching)
assert.equal(mismatch.checks.find((check) => check.id === 'recipient-matches-preflight')?.result, 'FAIL')
assert.equal(mismatch.checks.find((check) => check.id === 'amount-matches-preflight')?.result, 'FAIL')
console.log('ok  existing receipt mismatch checks remain chain-neutral for Solana')

const d33Mismatch = deriveTaxonomyFindings({
  attribution: 'ATTRIBUTED',
  mandate: { amount_atomic: '170555', asset: SOLANA_USDC_MINT, recipient: DESTINATION_OWNER, network: SOLANA_CAIP2 },
  observation: { amount_atomic: '170556', asset: SOLANA_USDC_MINT, recipient: '8GHEeLKAXHHiQjRBq57u9atZKD6wwbGrmptmfMVsVoxK', network: SOLANA_CAIP2 },
})
assert.ok(d33Mismatch.some((finding) => finding.code === 'AMOUNT_MISMATCH'))
assert.ok(d33Mismatch.some((finding) => finding.code === 'RECIPIENT_MISMATCH'))
console.log('ok  existing D3.3 codes compare canonical Solana addresses without a Solana-specific taxonomy')

// 3. A transaction above the RPC's finalized slot is never represented as confirmed settlement.
const pending = await observeSolanaTransaction(SIGNATURE, SOLANA_CAIP2, SOLANA_USDC_MINT, { client: rpc(SLOT - 1) })
assert.equal(pending.finality?.state, 'pending')
assert.equal(pending.sufficientlyConfirmed, false)
console.log('ok  non-finalized Solana transaction is not marked sufficiently confirmed')

// 5. Unsupported network/mint never enters the Solana observer scope.
await assert.rejects(
  observeSolanaTransaction(SIGNATURE, 'eip155:8453', SOLANA_USDC_MINT, { client: rpc() }),
  /does not support network/
)
console.log('ok  Solana observer rejects network mismatch')
