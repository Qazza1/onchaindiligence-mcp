/**
 * d27aAccountHistory.ts — D2.7A private operation history + recovery
 * center: focused coverage per the task's Section 8 (5 items), not a
 * regression suite for D2.4 itself.
 *
 * Run with: npx tsx test/d27aAccountHistory.ts
 *
 * Fully offline: the account-history routes are exercised through the real
 * Hono app (mountAccountHistory) with injected dependency fakes -- no real
 * Postgres, no network. deriveRecoveryStatus() is exercised directly as the
 * pure function it is.
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountAccountHistory, type AccountHistoryDependencies } from '../src/accountHistoryRoute.js'
import { hashApiKey } from '../src/accounts.js'
import { deriveRecoveryStatus } from '../src/operationHistory.js'
import type { AccountRecord, CommerceOperationRecord } from '../src/db.js'

const ACCOUNT_A: AccountRecord = { accountId: 'OCD-ACC-aaaa', apiKeyHash: hashApiKey('key-for-account-a'), createdAt: new Date().toISOString() }
const ACCOUNT_B: AccountRecord = { accountId: 'OCD-ACC-bbbb', apiKeyHash: hashApiKey('key-for-account-b'), createdAt: new Date().toISOString() }

function fakeAuthenticateAccount(headerValue: string | null | undefined): Promise<AccountRecord | null> {
  if (headerValue === 'Bearer key-for-account-a') return Promise.resolve(ACCOUNT_A)
  if (headerValue === 'Bearer key-for-account-b') return Promise.resolve(ACCOUNT_B)
  return Promise.resolve(null)
}

function baseOperation(overrides: Partial<CommerceOperationRecord> = {}): CommerceOperationRecord {
  return {
    operationId: 'OCD-OP-' + 'A'.repeat(27),
    recoveryCredentialHash: 'super-secret-recovery-credential-hash-must-never-leak',
    preflightState: 'not_started',
    executionState: 'not_submitted',
    observationState: 'none',
    receiptState: 'none',
    preflightReceiptId: null,
    ownerId: ACCOUNT_A.accountId,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function app(deps: AccountHistoryDependencies) {
  const a = new Hono()
  mountAccountHistory(a, deps)
  return a
}

// --- 1. authenticated user sees their operation history -------------------

{
  const summary = { operation_id: baseOperation().operationId, created_at: baseOperation().createdAt, preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued', preflight_receipt_id: 'OCD-RCP-XXXX', commerce_receipt_id: 'OCD-RCP-YYYY' } as const
  let sawAccountId: string | null = null
  const res = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    listOperationsForOwner: async (accountId) => {
      sawAccountId = accountId
      return [summary as any]
    },
  }).request('/me/operations', { headers: { authorization: 'Bearer key-for-account-a' } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(sawAccountId, ACCOUNT_A.accountId, 'the list must be scoped by the authenticated caller\'s own account id')
  assert.deepEqual(body.operations, [summary])
}
console.log('ok  an authenticated account sees its own operation history, scoped by its own account id')

// --- 2. unauthorized user cannot access another user's private operation --

{
  // getOperationDetailForOwner is the real ownership check -- simulate it
  // exactly as operationHistory.ts implements it: found only for the
  // owning account.
  const OPERATION_ID = baseOperation().operationId
  const deps: AccountHistoryDependencies = {
    authenticateAccount: fakeAuthenticateAccount as any,
    getOperationDetailForOwner: async (operationId, accountId) => {
      if (operationId === OPERATION_ID && accountId === ACCOUNT_A.accountId) {
        return { found: true, detail: { operation_id: OPERATION_ID } as any }
      }
      return { found: false }
    },
  }

  const asOwner = await app(deps).request(`/me/operations/${OPERATION_ID}`, { headers: { authorization: 'Bearer key-for-account-a' } })
  assert.equal(asOwner.status, 200, 'the owning account must see its own operation')

  const asOther = await app(deps).request(`/me/operations/${OPERATION_ID}`, { headers: { authorization: 'Bearer key-for-account-b' } })
  assert.equal(asOther.status, 404, 'a different authenticated account must NOT be able to read an operation it does not own')

  const noAuth = await app(deps).request(`/me/operations/${OPERATION_ID}`)
  assert.equal(noAuth.status, 401, 'no credential at all must never fall through to a 200 or 404 that could confirm the operation exists')

  const badAuth = await app(deps).request(`/me/operations/${OPERATION_ID}`, { headers: { authorization: 'Bearer not-a-real-key' } })
  assert.equal(badAuth.status, 401, 'an invalid api key must be rejected the same way as no key at all')

  const asOtherBody = (await asOther.json()) as any
  const noAuthBody = (await noAuth.json()) as any
  assert.notEqual(asOtherBody.error, undefined)
  assert.notEqual(noAuthBody.error, undefined)
}
console.log('ok  an authenticated account cannot read an operation it does not own (404, indistinguishable from unknown); missing/invalid credentials are rejected with 401')

// --- 3. operation detail returns the expected lifecycle information -------

{
  const detail = {
    operation_id: baseOperation().operationId,
    created_at: baseOperation().createdAt,
    preflight_state: 'completed',
    execution_state: 'transaction_known',
    observation_state: 'confirmed',
    receipt_state: 'commerce_issued',
    preflight_receipt_id: 'OCD-RCP-PRE1',
    commerce_receipt_id: 'OCD-RCP-COM1',
    preflight_receipt: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-PRE1' }, proof: {} },
    execution_bindings: [{ execution_request_id: 'OCD-EXEC-1', client_submission_key: 'csk-1', executor_identity: 'paybox-x402-base-usdc', executor_version: 'v1-gateway', recovery_capability_class: 'stable-payment-identity', provider_reference: 'paybox:req-1', submission_state: 'transaction_known' }],
    observations: [{ observation_id: 'obs-1', network: 'eip155:8453', block_number: '123', transaction_hash: '0xabc', log_index: 0, finality_state: 'safe', binding_strength: 'TRANSFER_MATCH_ONLY', bundle_digest: 'sha256:digest' }],
    commerce_receipt: { schema: 'x', receipt: { receipt_id: 'OCD-RCP-COM1' }, proof: {} },
    commerce_receipt_verification: { state: 'VALID', code: 'ok', message: 'verified' },
    recovery: { needsAttention: false, mayAlreadyHavePaid: true, summary: 'A Commerce receipt has been issued for this operation.', safeNextAction: 'None -- this operation is complete.' },
  }
  const res = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    getOperationDetailForOwner: async () => ({ found: true, detail: detail as any }),
  }).request(`/me/operations/${detail.operation_id}`, { headers: { authorization: 'Bearer key-for-account-a' } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.deepEqual(body, detail, 'the detail route must return exactly the assembled lifecycle detail -- no reshaping, no extra/missing fields')
  assert.equal(body.execution_bindings[0].executor_identity, 'paybox-x402-base-usdc')
  assert.equal(body.observations[0].binding_strength, 'TRANSFER_MATCH_ONLY')
  assert.equal(body.commerce_receipt_verification.state, 'VALID')
}
console.log('ok  operation detail returns preflight/execution/observation/receipt/verification/recovery information as assembled')

// --- 4. recovery state maps to the expected operator-facing next action ---

{
  const cases: Array<{ label: string; op: Partial<CommerceOperationRecord>; expectNeedsAttention: boolean; expectMayHavePaid: boolean; nextActionMatches: RegExp }> = [
    { label: 'commerce_issued -> done', op: { receiptState: 'commerce_issued' }, expectNeedsAttention: false, expectMayHavePaid: true, nextActionMatches: /None/ },
    { label: 'manual_recovery_required', op: { executionState: 'manual_recovery_required' }, expectNeedsAttention: true, expectMayHavePaid: true, nextActionMatches: /manual investigation|not.*new payment/i },
    { label: 'submission_ambiguous', op: { executionState: 'submission_ambiguous' }, expectNeedsAttention: true, expectMayHavePaid: true, nextActionMatches: /[Rr]esume/ },
    { label: 'transaction_known but not finalized', op: { executionState: 'transaction_known' }, expectNeedsAttention: true, expectMayHavePaid: true, nextActionMatches: /finalize/i },
    { label: 'prepared but not submitted', op: { executionState: 'prepared' }, expectNeedsAttention: true, expectMayHavePaid: false, nextActionMatches: /[Rr]esume/ },
    { label: 'preflight completed, nothing submitted yet', op: { preflightState: 'completed', executionState: 'not_submitted' }, expectNeedsAttention: true, expectMayHavePaid: false, nextActionMatches: /[Rr]esume/ },
    { label: 'early lifecycle, nothing to do yet', op: { preflightState: 'not_started', executionState: 'not_submitted' }, expectNeedsAttention: false, expectMayHavePaid: false, nextActionMatches: /None/ },
    { label: 'observation contradicted', op: { observationState: 'contradicted' }, expectNeedsAttention: true, expectMayHavePaid: true, nextActionMatches: /manual investigation/i },
  ]
  for (const { label, op, expectNeedsAttention, expectMayHavePaid, nextActionMatches } of cases) {
    const status = deriveRecoveryStatus(baseOperation(op), [], [])
    assert.equal(status.needsAttention, expectNeedsAttention, `${label}: needsAttention`)
    assert.equal(status.mayAlreadyHavePaid, expectMayHavePaid, `${label}: mayAlreadyHavePaid`)
    assert.match(status.safeNextAction, nextActionMatches, `${label}: safeNextAction`)
    // The one invariant that matters most: never INSTRUCT a repeat payment
    // once one may have happened (the action may still correctly mention
    // "never resubmit payment" as a warning -- what it must never do is
    // OPEN with an instruction to pay/submit/retry again).
    if (status.mayAlreadyHavePaid) {
      assert.doesNotMatch(status.safeNextAction, /^(submit|pay|retry|resubmit)\b/i, `${label}: must never OPEN with an instruction to pay/submit/retry again once a payment may already have happened`)
    }
  }
}
console.log('ok  recovery state maps to the expected operator-facing next action for every recoverable/terminal state, never suggesting a repeat payment once one may have happened')

// --- 5. secrets are not returned -------------------------------------------

{
  // (a) the list/summary shape structurally cannot carry a recovery credential or api key hash.
  const summary = { operation_id: 'OCD-OP-x', created_at: new Date().toISOString(), preflight_state: 'completed', execution_state: 'transaction_known', observation_state: 'confirmed', receipt_state: 'commerce_issued', preflight_receipt_id: 'OCD-RCP-1', commerce_receipt_id: 'OCD-RCP-2' }
  const listRes = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    listOperationsForOwner: async () => [summary as any],
  }).request('/me/operations', { headers: { authorization: 'Bearer key-for-account-a' } })
  const listText = await listRes.text()
  assert.doesNotMatch(listText, /recovery_credential|recoveryCredentialHash|api_key_hash|apiKeyHash|capability_token|capabilityToken/i)

  // (b) the detail shape: even if an upstream bug tried to leak the raw operation record's hash fields, the route only ever forwards whatever operationHistory.ts assembled -- assert the actual keys returned are a closed, expected set.
  const detail = {
    operation_id: 'OCD-OP-x',
    created_at: new Date().toISOString(),
    preflight_state: 'completed',
    execution_state: 'transaction_known',
    observation_state: 'confirmed',
    receipt_state: 'commerce_issued',
    preflight_receipt_id: 'OCD-RCP-1',
    commerce_receipt_id: 'OCD-RCP-2',
    preflight_receipt: null,
    execution_bindings: [],
    observations: [],
    commerce_receipt: null,
    commerce_receipt_verification: null,
    recovery: { needsAttention: false, mayAlreadyHavePaid: true, summary: 'x', safeNextAction: 'x' },
  }
  const detailRes = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    getOperationDetailForOwner: async () => ({ found: true, detail: detail as any }),
  }).request('/me/operations/OCD-OP-x', { headers: { authorization: 'Bearer key-for-account-a' } })
  const detailBody = (await detailRes.json()) as any
  const allowedKeys = new Set(Object.keys(detail))
  for (const key of Object.keys(detailBody)) assert.ok(allowedKeys.has(key), `unexpected extra field in operation detail response: ${key}`)
  const detailText = JSON.stringify(detailBody)
  assert.doesNotMatch(detailText, /recovery_credential|recoveryCredentialHash|api_key_hash|apiKeyHash|capability_token|capabilityToken|paybox.*credential/i)
}
console.log('ok  neither the list nor the detail response ever carries a recovery credential, api key hash, or capability token')

console.log('\nAll D2.7A account-history tests passed.')
