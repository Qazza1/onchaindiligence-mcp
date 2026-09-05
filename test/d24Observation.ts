/** D2.4 (Section 8/10, acceptance criterion #12, Section 15 test #10):
 * append-only exact chain-event observations.
 *
 * Run with: npx tsx test/d24Observation.ts
 *
 * Fully offline: an in-memory fake reproduces the real UNIQUE
 * (network, block_hash, transaction_hash, log_index) constraint's
 * "INSERT ... ON CONFLICT DO NOTHING" semantics from db.ts.
 */
import assert from 'node:assert/strict'
import { recordObservation } from '../src/commerceObservation.js'
import { buildPreflightCommitment } from '../src/commerceLifecycle.js'
import type { CommerceObservationRecord } from '../src/db.js'
import type { SettlementObservation, ObservedTransfer } from '../src/settlement.js'

const NETWORK = 'eip155:8453'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
const SENDER = '0x000000000000000000000000000000000000dEaD'

function makeFakeStore() {
  const rows = new Map<string, CommerceObservationRecord>() // key: natural key
  return {
    rows,
    deps: {
      recordCommerceObservation: async (params: any) => {
        const key = `${params.network}\0${params.blockHash}\0${params.transactionHash}\0${params.logIndex}`
        const existing = rows.get(key)
        if (existing) return { created: false, observation: existing }
        const record: CommerceObservationRecord = { ...params }
        rows.set(key, record)
        return { created: true, observation: record }
      },
    },
  }
}

function transfer(overrides: Partial<ObservedTransfer>): ObservedTransfer {
  return {
    assetContract: USDC,
    from: SENDER,
    to: RECIPIENT,
    amountAtomic: 1_000_000n,
    blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    transactionHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
    logIndex: 0,
    ...overrides,
  }
}

function observationFor(t: ObservedTransfer): SettlementObservation {
  return {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-05T00:00:00.000Z',
    confirmations: 10,
    sufficientlyConfirmed: true,
    transfers: [t],
    rpcError: null,
    paymentAuthorization: null,
  }
}

const commitment = buildPreflightCommitment({
  action: { kind: 'PAYMENT', resource: null, network: NETWORK, asset: USDC, amount: '1.00', sender: null, recipient: RECIPIENT },
  policy: { max_amount: null, allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null, expected_payer: null },
  screenRecipientSanctions: false,
  evidenceRefs: [],
  amountAtomic: '1000000',
  issuedAt: '2026-09-05T00:00:00.000Z',
  executionValidUntil: '2026-09-06T00:00:00.000Z',
})

function baseParams(t: ObservedTransfer, operationId: string) {
  return {
    operationId,
    network: NETWORK,
    observation: observationFor(t),
    selectedTransfer: t,
    expectedPayer: null,
    transferFieldsMatch: true,
    executionBinding: null,
    preflightReceiptId: 'OCD-RCP-TEST-0000-0000-0000',
    preflightReceiptDigest: 'sha256:test-digest',
    preflightCommitment: commitment,
    tokenContract: USDC,
    finalityClient: null,
    priorObservation: null,
  }
}

// --- the SAME exact event observed twice -> idempotent, one row -----------

{
  const { deps, rows } = makeFakeStore()
  const t = transfer({})
  const first = await recordObservation(baseParams(t, 'OCD-OP-op1'), deps)
  const second = await recordObservation(baseParams(t, 'OCD-OP-op1'), deps)
  assert.ok(first.created)
  assert.ok(!second.created, 'the identical exact event must never be recorded twice')
  assert.equal(rows.size, 1)
  assert.equal(first.observation?.observationId, second.observation?.observationId)
}
console.log('ok  the exact same chain event observed twice is idempotent -- one row, never duplicated')

// --- D2.4 Section 15 test #10: UNKNOWN -> CONFIRMED -> corrective observation, all preserved ---

{
  const { deps, rows } = makeFakeStore()
  const operationId = 'OCD-OP-op2'

  // First observation: a transient RPC race meant only a PARTIAL/UNKNOWN
  // settlement could be recorded (mirrors OCD-RCP-3HP5-CSBH-EGH9-PCNK).
  const firstTransfer = transfer({ logIndex: 1 })
  const first = await recordObservation(baseParams(firstTransfer, operationId), deps)
  assert.ok(first.created)

  // A LATER, corrective re-observation of a genuinely different exact event
  // (different log index -- e.g. a reorg re-inclusion, or the reconciled
  // observation) must be recorded as a NEW row, never overwrite the first.
  const secondTransfer = transfer({ logIndex: 2, blockHash: ('0x' + 'ef'.repeat(32)) as `0x${string}` })
  const second = await recordObservation(baseParams(secondTransfer, operationId), deps)
  assert.ok(second.created, 'a genuinely different exact event must be recorded as a new row')

  assert.equal(rows.size, 2, 'both observations must persist -- the corrective observation never replaces the first')
  assert.notEqual(first.observation?.observationId, second.observation?.observationId)

  // Repeated observation of either one again must still not inflate the count.
  await recordObservation(baseParams(firstTransfer, operationId), deps)
  await recordObservation(baseParams(secondTransfer, operationId), deps)
  assert.equal(rows.size, 2, 'repeated observation must never be counted as repeated fulfillment')
}
console.log('ok  a corrective re-observation appends a new row and preserves the prior one; repeats never inflate the count')

// --- no qualifying transfer -> a bundle is still produced, but nothing is persisted as a false observation ---

{
  const { deps, rows } = makeFakeStore()
  const noTransferObservation: SettlementObservation = {
    state: 'success',
    blockNumber: 100n,
    blockTimestamp: '2026-09-05T00:00:00.000Z',
    confirmations: 10,
    sufficientlyConfirmed: true,
    transfers: [],
    rpcError: null,
    paymentAuthorization: null,
  }
  const result = await recordObservation(
    { ...baseParams(transfer({}), 'OCD-OP-op3'), observation: noTransferObservation, selectedTransfer: null, transferFieldsMatch: false },
    deps
  )
  assert.equal(result.observation, null, 'no exact event to attach -- nothing is persisted as a fabricated observation row')
  assert.equal(rows.size, 0)
  assert.equal(result.bindingStrength, 'TRANSFER_MATCH_ONLY')
}
console.log('ok  no qualifying transfer never produces a fabricated observation row')

console.log('\nAll D2.4 append-only observation tests passed.')
