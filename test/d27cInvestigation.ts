/**
 * d27cInvestigation.ts — D2.7C investigation package + evidence export:
 * focused coverage per the task's Section 9 (4 items).
 *
 * Run with: npx tsx test/d27cInvestigation.ts
 *
 * Fully offline: getInvestigationForOwner() is exercised directly against
 * an injected fake getOperationDetailForOwner()/verifyReceipt() (same
 * OperationDetail shape D2.7A's own tests use); the HTTP routes are
 * exercised through the real Hono app (mountAccountHistory) with an
 * injected getInvestigationForOwner fake. No Postgres, no real network.
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountAccountHistory, type AccountHistoryDependencies } from '../src/accountHistoryRoute.js'
import { getInvestigationForOwner, buildInvestigationExport, summarizeInvestigation, type Investigation } from '../src/investigation.js'
import { hashApiKey } from '../src/accounts.js'
import type { AccountRecord } from '../src/db.js'
import type { OperationDetail, OperationDetailResult } from '../src/operationHistory.js'

const ACCOUNT_A: AccountRecord = { accountId: 'OCD-ACC-aaaa', apiKeyHash: hashApiKey('key-a'), createdAt: new Date().toISOString() }
const ACCOUNT_B: AccountRecord = { accountId: 'OCD-ACC-bbbb', apiKeyHash: hashApiKey('key-b'), createdAt: new Date().toISOString() }
function fakeAuthenticateAccount(h: string | null | undefined): Promise<AccountRecord | null> {
  if (h === 'Bearer key-a') return Promise.resolve(ACCOUNT_A)
  if (h === 'Bearer key-b') return Promise.resolve(ACCOUNT_B)
  return Promise.resolve(null)
}

const OPERATION_ID = 'OCD-OP-' + 'C'.repeat(27)

function completedOperationDetail(): OperationDetail {
  return {
    operation_id: OPERATION_ID,
    created_at: new Date().toISOString(),
    preflight_state: 'completed',
    execution_state: 'transaction_known',
    observation_state: 'confirmed',
    receipt_state: 'commerce_issued',
    preflight_receipt_id: 'OCD-RCP-PRE1',
    commerce_receipt_id: 'OCD-RCP-COM1',
    preflight_receipt: { schema: 'ocd.action-receipt.v1', receipt: { receipt_id: 'OCD-RCP-PRE1', decision: { status: 'ALLOW' }, action: { kind: 'PAYMENT', resource: 'https://api.onesource.io/api/chain/block-number', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '0.001', sender: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846', recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea' } }, proof: {} } as any,
    execution_bindings: [
      {
        execution_request_id: 'OCD-EXEC-1',
        client_submission_key: 'csk-1',
        executor_identity: 'paybox-x402-base-usdc',
        executor_version: 'v1-gateway',
        recovery_capability_class: 'stable-payment-identity',
        provider_reference: 'paybox:7a998655-147e-4cfb-8269-01672dfc515d',
        submission_state: 'transaction_known',
        expected_payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846',
      },
    ],
    observations: [
      {
        observation_id: 'obs-1',
        network: 'eip155:8453',
        block_hash: '0xblockhash',
        block_number: '50951350',
        transaction_hash: '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de',
        log_index: 510,
        observed_payer: '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846',
        observed_recipient: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea',
        observed_amount_atomic: '1000',
        token_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        finality_state: 'safe',
        binding_strength: 'TRANSFER_MATCH_ONLY',
        bundle_digest: 'sha256:evidencebundle',
      },
    ],
    commerce_receipt: { schema: 'ocd.action-receipt.v1', receipt: { receipt_id: 'OCD-RCP-COM1', settlement: { status: 'CONFIRMED' } }, proof: {} } as any,
    commerce_receipt_verification: { state: 'VALID', code: 'ok', message: 'verified' },
    recovery: { needsAttention: false, mayAlreadyHavePaid: true, summary: 'A Commerce receipt has been issued for this operation.', safeNextAction: 'None -- this operation is complete.' },
  }
}

function fakeVerifyReceipt() {
  return Promise.resolve({ state: 'VALID', code: 'ok', message: 'verified' })
}

/** No frozen policy.expected_payer commitment -- these tests aren't about D2.8A's EXPECTED_PAYER_MISMATCH rule; see test/d28aFindings.ts for that. */
function fakeGetStepState() {
  return Promise.resolve(null)
}

function app(deps: AccountHistoryDependencies) {
  const a = new Hono()
  mountAccountHistory(a, deps)
  return a
}

// --- 1. owner can fetch investigation package ------------------------------

let ownerInvestigation!: Investigation
{
  const detail = completedOperationDetail()
  const getOperationDetailForOwner = async (operationId: string, accountId: string): Promise<OperationDetailResult> =>
    operationId === OPERATION_ID && accountId === ACCOUNT_A.accountId ? { found: true, detail } : { found: false }

  const result = await getInvestigationForOwner(OPERATION_ID, ACCOUNT_A.accountId, { getOperationDetailForOwner, verifyReceipt: fakeVerifyReceipt as any, getStepState: fakeGetStepState as any })
  assert.equal(result.found, true)
  if (result.found) ownerInvestigation = result.investigation

  // Route-level: the owning account gets 200 with the assembled object.
  const res = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    getInvestigationForOwner: async (operationId, accountId) => getInvestigationForOwner(operationId, accountId, { getOperationDetailForOwner, verifyReceipt: fakeVerifyReceipt as any, getStepState: fakeGetStepState as any }),
  }).request(`/me/operations/${OPERATION_ID}/investigation`, { headers: { authorization: 'Bearer key-a' } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.operation.operation_id, OPERATION_ID)
  assert.ok(body.preflight && body.execution && body.settlement && body.evidence && body.receipts && body.recovery, 'the investigation object must contain all 7 documented sections')
}
console.log('ok  the owning account can fetch the assembled investigation package (operation/preflight/execution/settlement/evidence/receipts/recovery)')

// --- 2. other account receives 404 -----------------------------------------

{
  const detail = completedOperationDetail()
  const getOperationDetailForOwner = async (operationId: string, accountId: string): Promise<OperationDetailResult> =>
    operationId === OPERATION_ID && accountId === ACCOUNT_A.accountId ? { found: true, detail } : { found: false }

  const deps: AccountHistoryDependencies = {
    authenticateAccount: fakeAuthenticateAccount as any,
    getInvestigationForOwner: async (operationId, accountId) => getInvestigationForOwner(operationId, accountId, { getOperationDetailForOwner, verifyReceipt: fakeVerifyReceipt as any, getStepState: fakeGetStepState as any }),
  }

  const asOther = await app(deps).request(`/me/operations/${OPERATION_ID}/investigation`, { headers: { authorization: 'Bearer key-b' } })
  assert.equal(asOther.status, 404, 'a different account must not be able to fetch this investigation')

  const exportAsOther = await app(deps).request(`/me/operations/${OPERATION_ID}/investigation/export`, { headers: { authorization: 'Bearer key-b' } })
  assert.equal(exportAsOther.status, 404, 'a different account must not be able to fetch this export either')

  const noAuth = await app(deps).request(`/me/operations/${OPERATION_ID}/investigation`)
  assert.equal(noAuth.status, 401)
}
console.log('ok  a different account receives 404 (indistinguishable from unknown) for both the investigation and its export; no credential is rejected with 401')

// --- 3. completed operation contains expected receipt/execution/settlement evidence ---

{
  assert.equal(ownerInvestigation.preflight.decision, 'ALLOW')
  assert.equal(ownerInvestigation.preflight.receipt_id, 'OCD-RCP-PRE1')
  assert.equal((ownerInvestigation.preflight.verification as any)?.state, 'VALID')

  assert.equal(ownerInvestigation.execution.executor_identity, 'paybox-x402-base-usdc')
  assert.equal(ownerInvestigation.execution.executor_version, 'v1-gateway')
  assert.equal(ownerInvestigation.execution.provider_reference, 'paybox:7a998655-147e-4cfb-8269-01672dfc515d')
  assert.equal(ownerInvestigation.execution.submission_state, 'transaction_known')
  assert.equal(ownerInvestigation.execution.expected_payer, '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846')
  assert.equal(ownerInvestigation.execution.transaction_hash, '0xad0714b140f47edd862ab893b001dfe8acbae27dfa8ca1200cbf368a839c18de')

  assert.equal(ownerInvestigation.settlement.network, 'eip155:8453')
  assert.equal(ownerInvestigation.settlement.block_number, '50951350')
  assert.equal(ownerInvestigation.settlement.log_index, 510)
  assert.equal(ownerInvestigation.settlement.payer, '0x4D4cd7e2Ff500483c1ea4B2cFA68e1cf41F93846')
  assert.equal(ownerInvestigation.settlement.recipient, '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea')
  assert.equal(ownerInvestigation.settlement.settlement_state, 'CONFIRMED')
  assert.equal(ownerInvestigation.settlement.finality_state, 'safe')

  assert.equal(ownerInvestigation.evidence.binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.equal(ownerInvestigation.evidence.bundle_digest, 'sha256:evidencebundle')
  assert.equal(ownerInvestigation.evidence.event_identity?.transaction_hash, ownerInvestigation.settlement.transaction_hash)

  assert.equal((ownerInvestigation.receipts.verification as any)?.state, 'VALID')
  assert.equal((ownerInvestigation.receipts.commerce as any)?.receipt?.receipt_id, 'OCD-RCP-COM1')

  assert.equal(ownerInvestigation.recovery.needs_attention, false)

  const summary = summarizeInvestigation(ownerInvestigation)
  assert.match(summary, /Decision: ALLOW/)
  assert.match(summary, /Execution: transaction known/)
  assert.match(summary, /Settlement: CONFIRMED/)
  assert.match(summary, /Receipt: VALID/)
  assert.match(summary, /Binding: TRANSFER_MATCH_ONLY/)
  assert.match(summary, /Recovery: none required/)
}
console.log('ok  a completed operation\'s investigation contains the expected preflight/execution/settlement/evidence/receipt content, and summarizes deterministically')

// --- 4. exported package contains no secrets -------------------------------

{
  const exported = buildInvestigationExport({ accountId: ACCOUNT_A.accountId, investigation: ownerInvestigation })
  assert.equal(exported.schema, 'onchaindiligence.investigation.v1')
  assert.equal(exported.operation_id, OPERATION_ID)
  assert.ok(exported.digest.startsWith('sha256:'))
  assert.ok(exported.artifacts.length > 0)

  const serialized = JSON.stringify(exported)
  assert.doesNotMatch(serialized, /recovery_credential|api_key|apiKey|capability_token|capabilityToken|signing_secret|signingSecret|paybox.*credential|x_payment|x-payment|authorization_payload/i)

  // Digest is deterministic for the SAME investigation content.
  const exportedAgain = buildInvestigationExport({ accountId: ACCOUNT_A.accountId, investigation: ownerInvestigation })
  assert.equal(exportedAgain.digest, exported.digest, 'the digest must be a deterministic function of the investigation content, not include generated_at or be otherwise random')
}
console.log('ok  the exported investigation package (onchaindiligence.investigation.v1) contains no secret-shaped fields and has a deterministic content digest')

// --- regression: export must not 500 when an underlying record is missing an optional field ---
// (found live during this task: a sparse/incomplete observation record with
// no block_hash produced a literal `undefined` in evidence.event_identity,
// which receipts.ts's canonicalizeJson() throws on -- see investigation.ts's
// buildInvestigationExport() JSON round-trip fix.)
{
  const sparseDetail = completedOperationDetail()
  // @ts-expect-error -- deliberately simulating a record missing a field real DB rows always have, to prove the export path tolerates it
  delete sparseDetail.observations[0].block_hash
  const getOperationDetailForOwner = async (): Promise<OperationDetailResult> => ({ found: true, detail: sparseDetail })
  const result = await getInvestigationForOwner(OPERATION_ID, ACCOUNT_A.accountId, { getOperationDetailForOwner, verifyReceipt: fakeVerifyReceipt as any, getStepState: fakeGetStepState as any })
  assert.equal(result.found, true)
  if (result.found) {
    const exported = buildInvestigationExport({ accountId: ACCOUNT_A.accountId, investigation: result.investigation })
    assert.ok(exported.digest.startsWith('sha256:'), 'export must succeed (not throw) even when an optional field is missing from an underlying record')
  }
}
console.log('ok  the export never throws on a sparse/incomplete underlying record -- a missing optional field is treated as absent, not a crash')

console.log('\nAll D2.7C investigation tests passed.')
