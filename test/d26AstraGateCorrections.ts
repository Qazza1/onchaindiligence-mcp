/** D2.6 Astra final-review gate corrections: three focused regression tests
 * for the exact blockers Astra's independent review found in
 * createOperationFinalizeHandler() (src/lifecycleFinalizeRoute.ts).
 *
 * Run with: npx tsx test/d26AstraGateCorrections.ts
 *
 * Fully offline: every dependency (operation store, execution binding
 * store, capability store, chain observation, signing, key registry,
 * consume-and-publish, operation-state update) is injected as a fake via
 * LifecycleFinalizeDependencies / FinalizeDependencies -- no real Postgres
 * write, no real RPC call, no real signing call, no live payment.
 *
 * 1. PAYBOX PROVIDER REFERENCE GATE (blocker 1) -- a PayBox v1-gateway
 *    execution binding with provider_reference still null must reject
 *    finalization before any capability consumption or observation write;
 *    a body provider_reference that conflicts with an already-attached
 *    binding must also reject; a body that matches (or omits) the durable
 *    value must proceed.
 * 2. CROSS-OPERATION CAPABILITY (blocker 2) -- a capability bound to a
 *    DIFFERENT operation's preflight receipt must be rejected before
 *    recordObservation(), leaving the presented capability unconsumed and
 *    the operation unchanged; the operation's OWN capability still
 *    succeeds.
 * 3. REVERTED TRANSACTION STATE (blocker 3) -- an independently observed
 *    reverted transaction produces a Commerce receipt with
 *    settlement.status NOT_CONFIRMED, and the durable operation's
 *    observation_state must never become 'confirmed' as a result.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import { Hono } from 'hono'
import { createOperationFinalizeHandler, type LifecycleFinalizeDependencies } from '../src/lifecycleFinalizeRoute.js'
import {
  finalizeReceiptCore,
  receiptAttestationSigningInput,
  PUBLIC_ACTION_RECEIPT_ISSUER,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  type Receipt,
  type PublicActionReceiptEnvelope,
  type ReceiptCoreFields,
} from '../src/receipts.js'
import type { SettlementObservation } from '../src/settlement.js'
import type { CapabilityRecord, CommerceOperationRecord, ExecutionBindingRecord, LifecycleStepRow } from '../src/db.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const SENDER = '0x2222222222222222222222222222222222222222'
const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const BLOCK_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`
const OPERATION_A = 'OCD-OP-' + 'A'.repeat(27)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const KEY_ID = 'ed25519-TESTKEYFORD26GATE'
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

async function makePreflightEnvelope(): Promise<PublicActionReceiptEnvelope> {
  const core: ReceiptCoreFields = {
    receipt_type: 'PREFLIGHT',
    issued_at: '2026-09-07T00:00:00.000Z',
    action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '1.00', sender: null, recipient: RECIPIENT },
    decision: { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'x' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  }
  const receipt = finalizeReceiptCore(core)
  const proof = await fakeSignReceipt(receipt)
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }
}

const preflightEnvelope = await makePreflightEnvelope()

const SUCCESS_OBSERVATION: SettlementObservation = {
  state: 'success',
  blockNumber: 100n,
  blockTimestamp: '2026-09-07T00:01:00.000Z',
  confirmations: 5,
  sufficientlyConfirmed: true,
  transfers: [{ assetContract: USDC, from: SENDER, to: RECIPIENT, amountAtomic: 1_000_000n, blockHash: BLOCK_HASH, transactionHash: TX_HASH, logIndex: 0 }],
  rpcError: null,
  paymentAuthorization: null,
}

const REVERTED_OBSERVATION: SettlementObservation = {
  state: 'reverted',
  blockNumber: 100n,
  blockTimestamp: null,
  confirmations: null,
  sufficientlyConfirmed: false,
  transfers: [],
  rpcError: null,
  paymentAuthorization: null,
}

function operationRecord(overrides: Partial<CommerceOperationRecord> = {}): CommerceOperationRecord {
  return {
    operationId: OPERATION_A,
    recoveryCredentialHash: 'unused-in-this-route',
    preflightState: 'completed',
    executionState: 'submitted',
    observationState: 'none',
    receiptState: 'preflight_only',
    preflightReceiptId: preflightEnvelope.receipt.receipt_id,
    createdAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  }
}

function bindingRecord(overrides: Partial<ExecutionBindingRecord> = {}): ExecutionBindingRecord {
  return {
    executionRequestId: 'OCD-EXEC-test',
    operationId: OPERATION_A,
    clientSubmissionKey: 'test-attempt-1',
    executorIdentity: 'paybox-x402-base-usdc',
    executorVersion: 'v1-gateway',
    recoveryCapabilityClass: 'stable-payment-identity',
    frozenPreflightReceiptId: preflightEnvelope.receipt.receipt_id,
    frozenPreflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
    expectedPayer: SENDER,
    providerReference: null,
    submissionState: 'submitted',
    ...overrides,
  }
}

function validCapabilityFor(preflightReceiptId: string): CapabilityRecord {
  return {
    capabilityHash: 'hash',
    preflightReceiptId,
    preflightReceiptDigest: preflightEnvelope.receipt.receipt_digest,
    expiresAt: '2099-01-01T00:00:00.000Z',
    usedAt: null,
    consumedTransactionHash: null,
    commerceReceiptId: null,
    publishCommerce: false,
  }
}

/** Deps that would let a WELL-FORMED request succeed end to end -- individual tests override just the piece they're probing. */
function successDeps(overrides: LifecycleFinalizeDependencies = {}): LifecycleFinalizeDependencies {
  return {
    getCommerceOperation: async () => operationRecord(),
    getExecutionBinding: async () => null,
    // No PayBox v1-gateway binding on this operation by default -- tests
    // that need one override this to also return it here, so the gateway
    // safety gate is discovered from DURABLE STATE, not merely from
    // whatever getExecutionBinding() happens to return for a supplied id.
    listExecutionBindingsForOperation: async () => [],
    // No completed preflight step on record -> the D2.4 evidence layer
    // gracefully degrades to "no evidence" (exactly like the existing,
    // unaffected legacy fallback) -- keeps these tests focused on the
    // gate/precheck logic, not the full evidence bundle.
    step: { getLifecycleStep: async () => null },
    finalize: {
      peekCapability: async () => validCapabilityFor(preflightEnvelope.receipt.receipt_id),
      getReceiptForFinalization: async () => ({ envelope: preflightEnvelope, isPublic: false }),
      observeTransaction: async () => SUCCESS_OBSERVATION,
      signReceipt: fakeSignReceipt,
      fetchKeyRegistry: async () => fakeRegistry,
      consumeCapabilityAndPublish: async () => ({ kind: 'consumed' as const }),
    },
    updateCommerceOperationState: async () => {},
    ...overrides,
  }
}

function appFor(deps: LifecycleFinalizeDependencies) {
  const app = new Hono()
  app.post('/operations/:operationId/finalize', createOperationFinalizeHandler(deps))
  return app
}

async function post(app: Hono, body: Record<string, unknown>, authorization = 'Bearer some-capability-token') {
  return app.request(`https://mcp.onchaindiligence.com/operations/${OPERATION_A}/finalize`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = { execution_request_id: 'OCD-EXEC-test', transaction_hash: TX_HASH, execution_provider: 'paybox' as const, provider_reference: null as string | null, result_digest: null }

/** Wires a PayBox v1-gateway binding into BOTH getExecutionBinding (id lookup) and listExecutionBindingsForOperation (durable-state discovery) consistently, matching what a real DB would return. */
function gatewayBindingDeps(overrides: Partial<ExecutionBindingRecord> = {}): LifecycleFinalizeDependencies {
  const binding = bindingRecord(overrides)
  return { getExecutionBinding: async () => binding, listExecutionBindingsForOperation: async () => [binding] }
}

// ===========================================================================
// 1. PAYBOX PROVIDER REFERENCE GATE
// ===========================================================================

{
  // providerReference still null on the durable binding -> reject, no
  // capability consumption, no observation write.
  let recordObservationCalled = false
  let consumeCalled = false
  const deps = successDeps({
    ...gatewayBindingDeps({ providerReference: null }),
    recordObservation: async () => {
      recordObservationCalled = true
      throw new Error('recordObservation must not be reached when provider_reference is null')
    },
    finalize: {
      ...successDeps().finalize,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' as const }
      },
    },
  })
  const res = await post(appFor(deps), VALID_BODY)
  assert.equal(res.status, 409, 'null provider_reference on a PayBox gateway binding must reject with 409')
  assert.equal(recordObservationCalled, false, 'no observation write before the gate passes')
  assert.equal(consumeCalled, false, 'no capability consumption before the gate passes')
}
console.log('ok  PayBox gateway binding with provider_reference: null -> 409, no observation write, no capability consumption')

{
  // Body provider_reference conflicts with the already-attached durable value -> reject.
  let consumeCalled = false
  const deps = successDeps({
    ...gatewayBindingDeps({ providerReference: 'paybox:req-original' }),
    finalize: {
      ...successDeps().finalize,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' as const }
      },
    },
  })
  const res = await post(appFor(deps), { ...VALID_BODY, provider_reference: 'paybox:req-DIFFERENT' })
  assert.equal(res.status, 409, 'a conflicting body provider_reference must reject with 409')
  assert.equal(consumeCalled, false, 'no capability consumption on a provider_reference conflict')
}
console.log('ok  conflicting body provider_reference against an already-attached binding -> 409, no capability consumption')

{
  // Body provider_reference matches (or omits) the durable value -> proceeds normally.
  const matching = await post(appFor(successDeps(gatewayBindingDeps({ providerReference: 'paybox:req-original' }))), {
    ...VALID_BODY,
    provider_reference: 'paybox:req-original',
  })
  assert.equal(matching.status, 200, 'a matching body provider_reference must be allowed through the gate')

  const omitted = await post(appFor(successDeps(gatewayBindingDeps({ providerReference: 'paybox:req-original' }))), VALID_BODY)
  assert.equal(omitted.status, 200, 'omitting provider_reference in the body (letting the durable value stand alone) must be allowed through the gate')
}
console.log('ok  a matching or omitted body provider_reference against an attached PayBox binding proceeds normally')

{
  // Astra remaining-bypass regression: the operation already has a durable
  // PayBox v1-gateway binding (provider_reference: null), but the finalize
  // request omits execution_request_id ENTIRELY -- the gate must still
  // fire, because it is discovered from durable operation state
  // (listExecutionBindingsForOperation), never from whether the caller
  // happened to mention a binding.
  let recordObservationCalled = false
  let consumeCalled = false
  let updateStateCalled = false
  let listBindingsCalled = false
  const { execution_request_id: _omit, ...bodyWithoutExecutionRequestId } = VALID_BODY
  const deps = successDeps({
    listExecutionBindingsForOperation: async (opId: string) => {
      listBindingsCalled = true
      assert.equal(opId, OPERATION_A)
      return [bindingRecord({ providerReference: null })]
    },
    getExecutionBinding: async () => {
      throw new Error('getExecutionBinding must not be reached -- no execution_request_id was supplied')
    },
    recordObservation: async () => {
      recordObservationCalled = true
      throw new Error('recordObservation must not be reached when the gateway binding is not selected')
    },
    finalize: {
      ...successDeps().finalize,
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' as const }
      },
    },
    updateCommerceOperationState: async () => {
      updateStateCalled = true
    },
  })
  const res = await post(appFor(deps), bodyWithoutExecutionRequestId)
  assert.equal(res.status, 409, 'a PayBox gateway binding existing on the operation must gate finalization even with no execution_request_id supplied')
  assert.equal(listBindingsCalled, true, 'gateway binding discovery must occur from durable operation state')
  assert.equal(recordObservationCalled, false, 'zero observation writes')
  assert.equal(consumeCalled, false, 'zero capability consumption')
  assert.equal(updateStateCalled, false, 'zero terminal operation updates')
}
console.log('ok  a durable PayBox gateway binding with provider_reference: null gates finalization even when execution_request_id is omitted entirely')

// ===========================================================================
// 2. CROSS-OPERATION CAPABILITY
// ===========================================================================

{
  // Operation A + A's execution binding + a capability bound to a DIFFERENT
  // preflight ("Preflight B") -> reject BEFORE recordObservation, capability
  // B left unconsumed, operation A unchanged.
  let recordObservationCalled = false
  let consumeCalled = false
  let updateStateCalled = false
  const deps = successDeps({
    getExecutionBinding: async () => bindingRecord({ executorIdentity: 'x402-base-usdc-exact', executorVersion: 'v1', providerReference: 'irrelevant-here' }),
    recordObservation: async () => {
      recordObservationCalled = true
      throw new Error('recordObservation must not be reached on a cross-operation capability mismatch')
    },
    finalize: {
      ...successDeps().finalize,
      peekCapability: async () => validCapabilityFor('OCD-RCP-PREFLIGHT-B-UNRELATED'),
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' as const }
      },
    },
    updateCommerceOperationState: async () => {
      updateStateCalled = true
    },
  })
  const res = await post(appFor(deps), { ...VALID_BODY, execution_provider: 'x402' as const })
  assert.equal(res.status, 409, 'a capability bound to a different preflight receipt must reject with 409')
  assert.equal(recordObservationCalled, false, 'evidence must never be computed for a mismatched capability')
  assert.equal(consumeCalled, false, 'the mismatched (Preflight B) capability must remain unconsumed')
  assert.equal(updateStateCalled, false, 'operation A must remain unchanged')
}
console.log('ok  operation A + a capability bound to preflight B -> 409 before recordObservation, capability B unconsumed, operation A unchanged')

{
  // The SAME operation's own, correctly-bound capability still succeeds.
  let consumeCalled = false
  const deps = successDeps({
    getExecutionBinding: async () => bindingRecord({ executorIdentity: 'x402-base-usdc-exact', executorVersion: 'v1', providerReference: 'irrelevant-here' }),
    finalize: {
      ...successDeps().finalize,
      peekCapability: async () => validCapabilityFor(preflightEnvelope.receipt.receipt_id),
      consumeCapabilityAndPublish: async () => {
        consumeCalled = true
        return { kind: 'consumed' as const }
      },
    },
  })
  const res = await post(appFor(deps), { ...VALID_BODY, execution_provider: 'x402' as const })
  assert.equal(res.status, 200, 'operation A finalizing with ITS OWN capability must still succeed')
  assert.equal(consumeCalled, true, 'the correct capability must be consumed')
}
console.log('ok  operation A finalizing with its own correctly-bound capability still succeeds')

// ===========================================================================
// 3. REVERTED TRANSACTION STATE
// ===========================================================================

{
  let recordedObservationState: CommerceOperationRecord['observationState'] | null = null
  const frozenStepRow: LifecycleStepRow = {
    operationId: OPERATION_A,
    stepKey: 'preflight',
    inputDigest: 'sha256:test-digest',
    status: 'completed',
    frozenInput: {
      input: {
        action: { kind: 'PAYMENT', resource: null, network: 'eip155:8453', asset: USDC, amount: '1.00', sender: null, recipient: RECIPIENT },
        policy: { max_amount: null, allowed_networks: null, allowed_assets: null, expected_recipient: null, allowed_resource_origins: null, expected_payer: null },
        options: { screen_recipient_sanctions: false },
        references: { mandate_digest: null },
        publication: { preflight: false, commerce: false },
      },
      issuedAt: '2026-09-07T00:00:00.000Z',
    },
    capabilityToken: null,
    capabilityExpiresAt: null,
    resultJson: null,
  }
  const deps = successDeps({
    getExecutionBinding: async () => bindingRecord({ executorIdentity: 'x402-base-usdc-exact', executorVersion: 'v1', providerReference: 'irrelevant-here' }),
    getReceiptForFinalization: async () => ({ envelope: preflightEnvelope, isPublic: false }),
    observeTransaction: async () => REVERTED_OBSERVATION, // the evidence-layer probe
    step: { getLifecycleStep: async () => frozenStepRow }, // a completed preflight step IS on record this time
    finalize: {
      ...successDeps().finalize,
      getReceiptForFinalization: async () => ({ envelope: preflightEnvelope, isPublic: false }),
      observeTransaction: async () => REVERTED_OBSERVATION, // finalizePayment()'s own independent observation
    },
    updateCommerceOperationState: async (_operationId, fields) => {
      recordedObservationState = fields.observationState ?? null
    },
  })
  const res = await post(appFor(deps), { ...VALID_BODY, execution_provider: 'x402' as const })
  assert.equal(res.status, 200, 'a reverted transaction is definitive and finalizes immediately, not pending')
  const responseBody = (await res.json()) as any
  assert.equal(responseBody.receipt.settlement.status, 'NOT_CONFIRMED', 'the signed Commerce receipt must report NOT_CONFIRMED for a reverted transaction')
  assert.notEqual(recordedObservationState, 'confirmed', 'the durable operation must never claim observation_state: confirmed for a reverted transaction')
}
console.log('ok  a reverted transaction produces a NOT_CONFIRMED Commerce receipt and never marks the durable operation observation_state: confirmed')

console.log('\nAll D2.6 Astra gate correction tests passed.')
