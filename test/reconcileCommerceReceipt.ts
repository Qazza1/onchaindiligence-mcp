/** D2.2B2 tests for scripts/reconcile-commerce-receipt.ts's orchestration.
 *
 * Run with: npx tsx test/reconcileCommerceReceipt.ts
 *
 * Fully offline: every dependency (receipt store, capability lookup,
 * reconciliation idempotency table, chain observation, signing, key
 * registry) is injected as a fake. No real Postgres write, no real RPC
 * call, no real signing call, and — the whole point of this task — no
 * payment of any kind is even reachable from this code path.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import {
  reconcileCommerceReceipt,
  readReceiptArg,
  priorResultDigest,
  ReconciliationAbortError,
  type ReconcileDependencies,
} from '../scripts/reconcile-commerce-receipt.js'
import { finalizeReceiptCore, receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE, PUBLIC_ACTION_RECEIPT_SCHEMA } from '../src/receipts.js'
import type { Receipt, PublicActionReceiptEnvelope, ReceiptCoreFields } from '../src/receipts.js'
import type { CapabilityRecord, ReconciliationOutcome } from '../src/db.js'
import type { SettlementObservation } from '../src/settlement.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const SENDER = '0x2222222222222222222222222222222222222222'
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const OTHER_TX_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const KEY_ID = 'ed25519-TESTKEYFORRECONCILE'
const fakeRegistry = [
  { key_id: KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2020-01-01T00:00:00.000Z', valid_until: null },
]
async function fakeSignReceipt(receipt: Receipt): Promise<PublicActionReceiptEnvelope['proof']> {
  const issued_at = new Date().toISOString()
  const signingInput = receiptAttestationSigningInput(receipt, {
    issuer: PUBLIC_ACTION_RECEIPT_ISSUER,
    purpose: PUBLIC_ACTION_RECEIPT_PURPOSE,
    issuedAt: issued_at,
    keyId: KEY_ID,
  })
  const signature = ed25519Sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return { signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: PUBLIC_ACTION_RECEIPT_ISSUER, purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issued_at, key_id: KEY_ID, algorithm: 'ed25519', signature }
}

// verifyReceiptEnvelope re-derives receipt_id from receipt_digest, so the id
// is whatever finalizeReceiptCore deterministically computes from this
// content — never independently overridden.
function unsignedPreflightCore(): ReceiptCoreFields {
  return {
    receipt_type: 'PREFLIGHT',
    issued_at: '2026-09-04T00:00:00.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '1.00', sender: null, recipient: RECIPIENT },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'x' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  }
}

async function signedPreflightEnvelope(): Promise<{ envelope: PublicActionReceiptEnvelope }> {
  const receipt = finalizeReceiptCore(unsignedPreflightCore())
  const proof = await fakeSignReceipt(receipt)
  return { envelope: { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof } }
}

async function signedCommerceEnvelope(overrides: Partial<ReceiptCoreFields> = {}, preflightReceiptId: string): Promise<PublicActionReceiptEnvelope> {
  const core: ReceiptCoreFields = {
    receipt_type: 'COMMERCE',
    issued_at: '2026-09-04T20:59:37.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: null, sender: null, recipient: null },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: 'x402', status: 'UNKNOWN', transaction_hash: TX_HASH, submitted_at: null, confirmed_at: null },
    settlement: { status: 'UNVERIFIED', detail: 'RPC unavailable' },
    checks: [{ id: 'transaction-found', result: 'UNKNOWN', summary: 'rpc unavailable', evidence_digest: null }],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: preflightReceiptId },
    limitations: [],
    ...overrides,
  }
  const receipt = finalizeReceiptCore(core)
  const proof = await fakeSignReceipt(receipt)
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }
}

const { envelope: preflightEnvelope } = await signedPreflightEnvelope()
const stuckCommerceEnvelope = await signedCommerceEnvelope({}, preflightEnvelope.receipt.receipt_id)

const SUCCESS_OBSERVATION: SettlementObservation = {
  state: 'success',
  blockNumber: 100n,
  blockTimestamp: '2026-09-04T21:05:00.000Z',
  confirmations: 12,
  sufficientlyConfirmed: true,
  transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n }],
  rpcError: null,
}
const STILL_UNAVAILABLE_OBSERVATION: SettlementObservation = {
  state: 'rpc-unavailable',
  blockNumber: null,
  blockTimestamp: null,
  confirmations: null,
  sufficientlyConfirmed: false,
  transfers: [],
  rpcError: 'still down',
}

const goodCapability: CapabilityRecord = {
  capabilityHash: 'hash',
  preflightReceiptId: preflightEnvelope.receipt.receipt_id,
  expiresAt: '2099-01-01T00:00:00.000Z',
  usedAt: '2026-09-04T20:59:37.000Z',
  consumedTransactionHash: TX_HASH,
  commerceReceiptId: stuckCommerceEnvelope.receipt.receipt_id,
  preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
  publishCommerce: true,
}

function baseDeps(overrides: ReconcileDependencies = {}): ReconcileDependencies {
  return {
    getReceiptForFinalization: async (id: string) => {
      if (id === stuckCommerceEnvelope.receipt.receipt_id) return { envelope: stuckCommerceEnvelope, isPublic: true }
      if (id === preflightEnvelope.receipt.receipt_id) return { envelope: preflightEnvelope, isPublic: false }
      return null
    },
    getCapabilityByCommerceReceiptId: async () => goodCapability,
    getReconciliationForPriorReceipt: async () => null,
    recordReconciliation: async (): Promise<ReconciliationOutcome> => ({ kind: 'created' }),
    observeTransaction: async () => SUCCESS_OBSERVATION,
    fetchKeyRegistry: async () => fakeRegistry,
    signReceipt: fakeSignReceipt,
    ...overrides,
  }
}

const PRIOR_RECEIPT_ID = stuckCommerceEnvelope.receipt.receipt_id

// --- readReceiptArg / priorResultDigest (pure helpers) --------------------

assert.equal(readReceiptArg(['node', 'script.js', '--receipt', PRIOR_RECEIPT_ID]), PRIOR_RECEIPT_ID)
assert.throws(() => readReceiptArg(['node', 'script.js']), ReconciliationAbortError, 'missing --receipt must abort')
assert.throws(() => readReceiptArg(['node', 'script.js', '--receipt', 'not-a-real-id']), ReconciliationAbortError, 'malformed receipt id must abort')
console.log('ok  readReceiptArg accepts only a valid --receipt id, aborts otherwise')

assert.equal(priorResultDigest(stuckCommerceEnvelope.receipt), null)
console.log('ok  priorResultDigest reads the stored check, never invents one')

// --- happy path: dry run -----------------------------------------------

{
  let observeCalledWith: any = null
  let recordCalled = false
  const outcome = await reconcileCommerceReceipt(
    PRIOR_RECEIPT_ID,
    { confirmed: false },
    baseDeps({
      observeTransaction: async (txHash, network, asset) => {
        observeCalledWith = { txHash, network, asset }
        return SUCCESS_OBSERVATION
      },
      recordReconciliation: async () => {
        recordCalled = true
        return { kind: 'created' }
      },
    })
  )
  assert.equal(outcome.kind, 'dry-run')
  assert.equal(observeCalledWith.txHash, TX_HASH, 'dry run must re-observe the EXACT transaction hash stored on the prior receipt')
  assert.equal(recordCalled, false, 'a dry run must never write anything')
  if (outcome.kind === 'dry-run') {
    assert.equal(outcome.built.execution.status, 'CONFIRMED')
    assert.equal(outcome.built.settlement.status, 'CONFIRMED')
  }
}
console.log('ok  dry run independently re-observes the exact stored transaction and writes nothing')

// --- happy path: confirmed reconciliation ---------------------------------

{
  let recordedWith: any = null
  const outcome = await reconcileCommerceReceipt(
    PRIOR_RECEIPT_ID,
    { confirmed: true },
    baseDeps({
      recordReconciliation: async (params: any) => {
        recordedWith = params
        return { kind: 'created' }
      },
    })
  )
  assert.equal(outcome.kind, 'reconciled')
  assert.ok(recordedWith)
  assert.equal(recordedWith.priorReceiptId, PRIOR_RECEIPT_ID)
  if (outcome.kind === 'reconciled') {
    assert.equal(outcome.envelope.receipt.receipt_type, 'COMMERCE')
    assert.equal(outcome.envelope.receipt.links.preflight_receipt_id, preflightEnvelope.receipt.receipt_id)
    assert.equal(outcome.envelope.receipt.execution.status, 'CONFIRMED')
    assert.equal(outcome.envelope.receipt.settlement.status, 'CONFIRMED')
    assert.notEqual(outcome.envelope.receipt.receipt_id, PRIOR_RECEIPT_ID, 'the reconciled receipt must be a NEW id, never overwrite the prior one')
    const priorObsCheck = outcome.envelope.receipt.checks.find((c) => c.id === 'prior-commerce-observation')
    assert.ok(priorObsCheck, 'must include the prior-commerce-observation check')
    assert.equal(priorObsCheck?.result, 'PASS')
    assert.equal(priorObsCheck?.evidence_digest, stuckCommerceEnvelope.receipt.receipt_digest)
    assert.ok(outcome.envelope.receipt.limitations.some((l) => l.includes(PRIOR_RECEIPT_ID)), 'limitations must mention the prior receipt id')
  }
}
console.log('ok  confirmed reconciliation produces a NEW valid COMMERCE receipt linking back to the prior one, never overwriting it')

// --- idempotency: already reconciled -> no re-observation, no re-write ----

{
  let observeCalled = false
  let recordCalled = false
  const outcome = await reconcileCommerceReceipt(
    PRIOR_RECEIPT_ID,
    { confirmed: true },
    baseDeps({
      getReconciliationForPriorReceipt: async () => ({ reconciledReceiptId: 'OCD-RCP-EXISTING-0000-0000' }),
      observeTransaction: async () => {
        observeCalled = true
        return SUCCESS_OBSERVATION
      },
      recordReconciliation: async () => {
        recordCalled = true
        return { kind: 'created' }
      },
    })
  )
  assert.equal(outcome.kind, 'already-reconciled')
  if (outcome.kind === 'already-reconciled') assert.equal(outcome.reconciledReceiptId, 'OCD-RCP-EXISTING-0000-0000')
  assert.equal(observeCalled, false, 'an already-reconciled prior receipt must not be re-observed')
  assert.equal(recordCalled, false, 'an already-reconciled prior receipt must never be written again')
}
console.log('ok  idempotent: an already-reconciled receipt short-circuits before any re-observation or write')

// --- race at the DB layer: recordReconciliation itself reports the race ---

{
  const outcome = await reconcileCommerceReceipt(
    PRIOR_RECEIPT_ID,
    { confirmed: true },
    baseDeps({ recordReconciliation: async () => ({ kind: 'already-reconciled', reconciledReceiptId: 'OCD-RCP-RACE-0000-0000-0000' }) })
  )
  assert.equal(outcome.kind, 'race-already-reconciled')
}
console.log('ok  a race detected only at the database layer is still reported correctly, not as a duplicate')

// --- observation still not definitive -> nothing written -----------------

{
  let recordCalled = false
  const outcome = await reconcileCommerceReceipt(
    PRIOR_RECEIPT_ID,
    { confirmed: true },
    baseDeps({
      observeTransaction: async () => STILL_UNAVAILABLE_OBSERVATION,
      recordReconciliation: async () => {
        recordCalled = true
        return { kind: 'created' }
      },
    })
  )
  assert.equal(outcome.kind, 'not-definitive')
  assert.equal(recordCalled, false)
}
console.log('ok  still-not-definitive observation writes nothing, even with --confirm-reconcile')

// --- safety gates before any observation --------------------------------

await assert.rejects(
  () => reconcileCommerceReceipt('OCD-RCP-NOPE0-0000-0000-0000', { confirmed: false }, baseDeps({ getReceiptForFinalization: async () => null })),
  ReconciliationAbortError
)
console.log('ok  unknown receipt id aborts')

{
  const notCommerce = await signedPreflightEnvelope()
  await assert.rejects(
    () =>
      reconcileCommerceReceipt(
        PRIOR_RECEIPT_ID,
        { confirmed: false },
        baseDeps({ getReceiptForFinalization: async () => ({ envelope: notCommerce.envelope, isPublic: false }) })
      ),
    ReconciliationAbortError
  )
}
console.log('ok  a receipt that is not type COMMERCE aborts')

{
  const alreadyDefinite = await signedCommerceEnvelope(
    { execution: { provider: 'x402', status: 'CONFIRMED', transaction_hash: TX_HASH, submitted_at: null, confirmed_at: '2026-09-04T21:00:00.000Z' }, settlement: { status: 'CONFIRMED', detail: 'ok' } },
    preflightEnvelope.receipt.receipt_id
  )
  await assert.rejects(
    () =>
      reconcileCommerceReceipt(
        PRIOR_RECEIPT_ID,
        { confirmed: false },
        baseDeps({
          getReceiptForFinalization: async (id: string) => {
            if (id === PRIOR_RECEIPT_ID) return { envelope: alreadyDefinite, isPublic: true }
            if (id === preflightEnvelope.receipt.receipt_id) return { envelope: preflightEnvelope, isPublic: false }
            return null
          },
        })
      ),
    ReconciliationAbortError
  )
}
console.log('ok  an already-definitive receipt refuses to be "reconciled" again')

await assert.rejects(
  () => reconcileCommerceReceipt(PRIOR_RECEIPT_ID, { confirmed: false }, baseDeps({ getCapabilityByCommerceReceiptId: async () => null })),
  ReconciliationAbortError
)
console.log('ok  no matching consumed capability record aborts')

await assert.rejects(
  () =>
    reconcileCommerceReceipt(
      PRIOR_RECEIPT_ID,
      { confirmed: false },
      baseDeps({ getCapabilityByCommerceReceiptId: async () => ({ ...goodCapability, consumedTransactionHash: OTHER_TX_HASH }) })
    ),
  ReconciliationAbortError
)
console.log('ok  a capability record referencing a DIFFERENT transaction hash aborts')

await assert.rejects(
  () =>
    reconcileCommerceReceipt(
      PRIOR_RECEIPT_ID,
      { confirmed: false },
      baseDeps({ getCapabilityByCommerceReceiptId: async () => ({ ...goodCapability, preflightReceiptId: 'OCD-RCP-WRONG-0000-0000-0000' }) })
    ),
  ReconciliationAbortError
)
console.log('ok  a capability record referencing a DIFFERENT preflight aborts')

console.log('\nAll D2.2B2 reconcile-commerce-receipt tests passed.')
