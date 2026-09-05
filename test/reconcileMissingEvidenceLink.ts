/** D2.5A tests for reconcileMissingEvidenceLink()'s orchestration.
 *
 * Run with: npx tsx test/reconcileMissingEvidenceLink.ts
 *
 * Fully offline: every dependency (receipt store, capability lookup,
 * operation lookup, observation lookup, reconciliation idempotency table,
 * signing, key registry) is injected as a fake. No real Postgres write, no
 * real RPC call (this reconciliation NEVER re-observes the chain -- see the
 * module's own header), no real signing call, no payment of any kind is
 * even reachable from this code path.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import {
  reconcileMissingEvidenceLink,
  type EvidenceLinkReconcileDependencies,
} from '../scripts/reconcile-commerce-receipt.js'
import { finalizeReceiptCore, receiptAttestationSigningInput, PUBLIC_ACTION_RECEIPT_ISSUER, PUBLIC_ACTION_RECEIPT_PURPOSE, PUBLIC_ACTION_RECEIPT_SCHEMA } from '../src/receipts.js'
import type { Receipt, PublicActionReceiptEnvelope, ReceiptCoreFields } from '../src/receipts.js'
import type { CapabilityRecord, CommerceOperationRecord, CommerceObservationRecord, ReconciliationOutcome } from '../src/db.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const SENDER = '0x2222222222222222222222222222222222222222'
const TX_HASH = ('0x' + 'ef'.repeat(32)) as `0x${string}`
const BLOCK_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const OPERATION_ID = 'OCD-OP-' + 'E'.repeat(27)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const KEY_ID = 'ed25519-TESTKEYFOREVIDENCELINK'
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
  return { signed: true, schema_version: 'onchaindiligence.attestation.v2', issuer: PUBLIC_ACTION_RECEIPT_ISSUER, purpose: PUBLIC_ACTION_RECEIPT_PURPOSE, issued_at, key_id: KEY_ID, algorithm: 'ed25519', canonicalization: 'RFC8785', signature }
}

function unsignedPreflightCore(): ReceiptCoreFields {
  return {
    receipt_type: 'PREFLIGHT',
    issued_at: '2026-09-05T00:00:00.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '0.001', sender: null, recipient: RECIPIENT },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'x' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  }
}

async function signedPreflightEnvelope(): Promise<PublicActionReceiptEnvelope> {
  const receipt = finalizeReceiptCore(unsignedPreflightCore())
  const proof = await fakeSignReceipt(receipt)
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }
}

async function signedDefinitiveCommerceEnvelope(preflightReceiptId: string, overrides: Partial<ReceiptCoreFields> = {}): Promise<PublicActionReceiptEnvelope> {
  const core: ReceiptCoreFields = {
    receipt_type: 'COMMERCE',
    issued_at: '2026-09-05T19:48:16.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '0.001', sender: SENDER, recipient: RECIPIENT },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: 'x402', status: 'CONFIRMED', transaction_hash: TX_HASH, submitted_at: null, confirmed_at: '2026-09-05T19:48:00.000Z' },
    settlement: { status: 'CONFIRMED', detail: 'Independently observed on Base mainnet: the proposed transfer settled exactly as preflighted.' },
    checks: [{ id: 'settlement-confirmed', result: 'PASS', summary: 'ok', evidence_digest: null }],
    // The exact confirmed live incident: definitively CONFIRMED/CONFIRMED,
    // but signed before the evidence bundle digest was committed.
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: preflightReceiptId },
    limitations: [],
    ...overrides,
  }
  const receipt = finalizeReceiptCore(core)
  const proof = await fakeSignReceipt(receipt)
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }
}

const preflightEnvelope = await signedPreflightEnvelope()
const priorCommerceEnvelope = await signedDefinitiveCommerceEnvelope(preflightEnvelope.receipt.receipt_id)
const PRIOR_RECEIPT_ID = priorCommerceEnvelope.receipt.receipt_id

const goodCapability: CapabilityRecord = {
  capabilityHash: 'hash',
  preflightReceiptId: preflightEnvelope.receipt.receipt_id,
  expiresAt: '2099-01-01T00:00:00.000Z',
  usedAt: '2026-09-05T19:48:00.000Z',
  consumedTransactionHash: TX_HASH,
  commerceReceiptId: PRIOR_RECEIPT_ID,
  preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
  publishCommerce: true,
}

const goodOperation: CommerceOperationRecord = {
  operationId: OPERATION_ID,
  recoveryCredentialHash: 'irrelevant-for-this-reconciliation',
  preflightState: 'completed',
  executionState: 'transaction_known',
  observationState: 'confirmed',
  receiptState: 'commerce_issued',
  preflightReceiptId: preflightEnvelope.receipt.receipt_id,
  createdAt: '2026-09-05T18:33:53.000Z',
}

const EXISTING_BUNDLE_DIGEST = 'sha256:existing-real-bundle-digest-AAAAAAAAAAAAAAAAAAAAAAAAAA'
const goodObservation: CommerceObservationRecord = {
  observationId: 'sha256:fake-observation-id',
  operationId: OPERATION_ID,
  network: 'eip155:8453',
  blockNumber: '100',
  blockHash: BLOCK_HASH,
  transactionHash: TX_HASH,
  logIndex: 0,
  observedPayer: SENDER,
  observedRecipient: RECIPIENT,
  observedAmountAtomic: '1000',
  tokenContract: USDC,
  paymentAuthorizer: SENDER,
  paymentAuthorizationNonce: '0x' + '11'.repeat(32),
  finalityPolicy: 'base-mainnet-v1',
  finalityState: 'safe',
  chainHeadUsed: null,
  bindingStrength: 'PAYMENT_IDENTITY_LINKED',
  bundleDigest: EXISTING_BUNDLE_DIGEST,
}

function baseDeps(overrides: EvidenceLinkReconcileDependencies = {}): EvidenceLinkReconcileDependencies {
  return {
    getReceiptForFinalization: async (id: string) => {
      if (id === PRIOR_RECEIPT_ID) return { envelope: priorCommerceEnvelope, isPublic: true }
      if (id === preflightEnvelope.receipt.receipt_id) return { envelope: preflightEnvelope, isPublic: false }
      return null
    },
    getCapabilityByCommerceReceiptId: async () => goodCapability,
    getReconciliationForPriorReceipt: async () => null,
    recordReconciliation: async (): Promise<ReconciliationOutcome> => ({ kind: 'created' }),
    getCommerceOperation: async () => goodOperation,
    listCommerceObservations: async () => [goodObservation],
    fetchKeyRegistry: async () => fakeRegistry,
    signReceipt: fakeSignReceipt,
    ...overrides,
  }
}

// --- happy path: dry run ----------------------------------------------------

{
  let recordCalled = false
  const outcome = await reconcileMissingEvidenceLink(PRIOR_RECEIPT_ID, OPERATION_ID, { confirmed: false }, baseDeps({ recordReconciliation: async () => { recordCalled = true; return { kind: 'created' } } }))
  assert.equal(outcome.kind, 'dry-run')
  assert.equal(recordCalled, false, 'a dry run must never write anything')
  if (outcome.kind === 'dry-run') {
    assert.equal(outcome.bundleDigest, EXISTING_BUNDLE_DIGEST, 'must reuse the EXISTING stored bundle digest, never recompute one')
    assert.equal(outcome.bindingStrength, 'PAYMENT_IDENTITY_LINKED')
  }
}
console.log('ok  dry run reuses the existing stored evidence bundle and writes nothing')

// --- happy path: confirmed reconciliation -----------------------------------

{
  let recordedWith: any = null
  const outcome = await reconcileMissingEvidenceLink(PRIOR_RECEIPT_ID, OPERATION_ID, { confirmed: true }, baseDeps({ recordReconciliation: async (params: any) => { recordedWith = params; return { kind: 'created' } } }))
  assert.equal(outcome.kind, 'reconciled')
  assert.ok(recordedWith)
  assert.equal(recordedWith.priorReceiptId, PRIOR_RECEIPT_ID)
  if (outcome.kind === 'reconciled') {
    assert.equal(outcome.envelope.receipt.receipt_type, 'COMMERCE')
    assert.notEqual(outcome.envelope.receipt.receipt_id, PRIOR_RECEIPT_ID, 'the reconciled receipt must be a NEW id, never overwrite the prior one')
    assert.equal(outcome.envelope.receipt.links.agent_evidence_bundle_digest, EXISTING_BUNDLE_DIGEST, 'the evidence bundle must now be linked from the signed receipt')
    assert.equal(outcome.envelope.receipt.links.preflight_receipt_id, preflightEnvelope.receipt.receipt_id)
    // Execution/settlement must be copied VERBATIM -- never re-derived.
    assert.equal(outcome.envelope.receipt.execution.status, 'CONFIRMED')
    assert.equal(outcome.envelope.receipt.execution.transaction_hash, TX_HASH)
    assert.equal(outcome.envelope.receipt.settlement.status, 'CONFIRMED')
    const priorCheck = outcome.envelope.receipt.checks.find((c) => c.id === 'prior-commerce-receipt')
    assert.ok(priorCheck, 'must include the prior-commerce-receipt check')
    assert.equal(priorCheck?.evidence_digest, priorCommerceEnvelope.receipt.receipt_digest)
    assert.ok(outcome.envelope.receipt.limitations.some((l) => l.includes(PRIOR_RECEIPT_ID)), 'limitations must mention the prior receipt id')
  }
}
console.log('ok  confirmed reconciliation produces a NEW valid COMMERCE receipt with the evidence bundle linked, execution/settlement copied verbatim, never overwriting the prior receipt')

// --- idempotency -------------------------------------------------------------

{
  let observationsCalled = false
  const outcome = await reconcileMissingEvidenceLink(
    PRIOR_RECEIPT_ID,
    OPERATION_ID,
    { confirmed: true },
    baseDeps({
      getReconciliationForPriorReceipt: async () => ({ reconciledReceiptId: 'OCD-RCP-EXISTING-0000-0000' }),
      listCommerceObservations: async () => { observationsCalled = true; return [goodObservation] },
    })
  )
  assert.equal(outcome.kind, 'already-reconciled')
  if (outcome.kind === 'already-reconciled') assert.equal(outcome.reconciledReceiptId, 'OCD-RCP-EXISTING-0000-0000')
  assert.equal(observationsCalled, false, 'an already-reconciled prior receipt must not even look up observations again')
}
console.log('ok  idempotent: an already-reconciled receipt short-circuits before any further lookup or write')

// --- safety gates ------------------------------------------------------------

await assert.rejects(
  () => reconcileMissingEvidenceLink('OCD-RCP-NOPE0-0000-0000-0000', OPERATION_ID, { confirmed: false }, baseDeps({ getReceiptForFinalization: async () => null })),
  /no receipt found/
)
console.log('ok  unknown receipt id aborts')

{
  const alreadyLinked = await signedDefinitiveCommerceEnvelope(preflightEnvelope.receipt.receipt_id, { links: { agent_evidence_bundle_digest: 'sha256:already-linked', preflight_receipt_id: preflightEnvelope.receipt.receipt_id } })
  await assert.rejects(
    () =>
      reconcileMissingEvidenceLink(
        alreadyLinked.receipt.receipt_id,
        OPERATION_ID,
        { confirmed: false },
        baseDeps({
          getReceiptForFinalization: async (id: string) => {
            if (id === alreadyLinked.receipt.receipt_id) return { envelope: alreadyLinked, isPublic: true }
            if (id === preflightEnvelope.receipt.receipt_id) return { envelope: preflightEnvelope, isPublic: false }
            return null
          },
        })
      ),
    /already carries an evidence bundle link/
  )
}
console.log('ok  a receipt that already carries an evidence bundle link refuses to be "reconciled" again')

{
  const indefinite = await signedDefinitiveCommerceEnvelope(preflightEnvelope.receipt.receipt_id, { execution: { provider: 'x402', status: 'UNKNOWN', transaction_hash: TX_HASH, submitted_at: null, confirmed_at: null }, settlement: { status: 'UNVERIFIED', detail: 'x' } })
  await assert.rejects(
    () =>
      reconcileMissingEvidenceLink(
        indefinite.receipt.receipt_id,
        OPERATION_ID,
        { confirmed: false },
        baseDeps({
          getReceiptForFinalization: async (id: string) => {
            if (id === indefinite.receipt.receipt_id) return { envelope: indefinite, isPublic: true }
            if (id === preflightEnvelope.receipt.receipt_id) return { envelope: preflightEnvelope, isPublic: false }
            return null
          },
        })
      ),
    /not a definitively confirmed receipt/
  )
}
console.log('ok  a still-indefinite receipt refuses this reconciliation path (use reconcileCommerceReceipt instead)')

await assert.rejects(
  () => reconcileMissingEvidenceLink(PRIOR_RECEIPT_ID, OPERATION_ID, { confirmed: false }, baseDeps({ getCapabilityByCommerceReceiptId: async () => null })),
  /no finalization capability record/
)
console.log('ok  no matching consumed capability record aborts')

await assert.rejects(
  () => reconcileMissingEvidenceLink(PRIOR_RECEIPT_ID, 'OCD-OP-' + 'F'.repeat(27), { confirmed: false }, baseDeps({ getCommerceOperation: async () => null })),
  /no commerce operation found/
)
console.log('ok  unknown operation id aborts')

await assert.rejects(
  () =>
    reconcileMissingEvidenceLink(
      PRIOR_RECEIPT_ID,
      OPERATION_ID,
      { confirmed: false },
      baseDeps({ getCommerceOperation: async () => ({ ...goodOperation, preflightReceiptId: 'OCD-RCP-WRONG-0000-0000-0000' }) })
    ),
  /does not match the one linked/
)
console.log('ok  an operation whose own preflight receipt does not match the receipt being reconciled aborts')

await assert.rejects(
  () => reconcileMissingEvidenceLink(PRIOR_RECEIPT_ID, OPERATION_ID, { confirmed: false }, baseDeps({ listCommerceObservations: async () => [] })),
  /nothing to link/
)
console.log('ok  no stored observation with a bundle digest for this transaction aborts')

console.log('\nAll D2.5A reconcile-missing-evidence-link tests passed.')
