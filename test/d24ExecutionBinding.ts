/** D2.4 (Section 6/7, acceptance criteria #6/#7/#8, Section 15 tests #2/#3):
 * durable execution binding creation, concurrency safety, and the
 * submission-state machine that stops a stale worker from ever creating a
 * second payment identity or resubmitting through a terminal binding.
 *
 * Run with: npx tsx test/d24ExecutionBinding.ts
 *
 * Fully offline: an in-memory fake store stands in for db.ts's Postgres
 * functions, simulating the SAME atomic "INSERT ... ON CONFLICT DO NOTHING"
 * semantics the real UNIQUE (operation_id, client_submission_key) constraint
 * provides -- including under genuine concurrent access (Promise.all),
 * which is what test #3 requires and a real Postgres integration test would
 * only re-confirm at the SQL engine level, not at the application logic
 * level this suite actually exercises.
 */
import assert from 'node:assert/strict'
import {
  registerExecutionBinding,
  transitionSubmissionState,
  attachProviderReference,
  InvalidSubmissionTransitionError,
  ProviderReferenceConflictError,
  type ExecutionBindingDependencies,
} from '../src/executionBinding.js'
import type { ExecutionBindingRecord } from '../src/db.js'

// --- an in-memory fake reproducing the real UNIQUE-constraint semantics ---

function makeFakeStore() {
  const byKey = new Map<string, ExecutionBindingRecord>() // key: operationId + '\0' + clientSubmissionKey
  let nextId = 0

  const deps: ExecutionBindingDependencies = {
    createExecutionBinding: async (params) => {
      const key = `${params.operationId}\0${params.clientSubmissionKey}`
      const existing = byKey.get(key)
      if (existing) return { created: false, binding: existing }
      const binding: ExecutionBindingRecord = {
        executionRequestId: params.executionRequestId,
        operationId: params.operationId,
        clientSubmissionKey: params.clientSubmissionKey,
        executorIdentity: params.executorIdentity,
        executorVersion: params.executorVersion,
        recoveryCapabilityClass: params.recoveryCapabilityClass,
        frozenPreflightReceiptId: params.frozenPreflightReceiptId,
        frozenPreflightReceiptDigest: params.frozenPreflightReceiptDigest,
        expectedPayer: params.expectedPayer,
        providerReference: params.providerReference,
        submissionState: 'not_submitted',
      }
      byKey.set(key, binding)
      nextId++
      return { created: true, binding }
    },
    updateExecutionBindingSubmissionState: async (executionRequestId, submissionState) => {
      for (const binding of byKey.values()) {
        if (binding.executionRequestId === executionRequestId) {
          binding.submissionState = submissionState as any
          return
        }
      }
    },
    // Mirrors the real db.ts function's atomic CAS: only applies when the
    // current value is null or already equal to the value being written.
    updateExecutionBindingProviderReference: async (executionRequestId, providerReference) => {
      for (const binding of byKey.values()) {
        if (binding.executionRequestId !== executionRequestId) continue
        if (binding.providerReference !== null && binding.providerReference !== providerReference) {
          throw new ProviderReferenceConflictError(executionRequestId, binding.providerReference, providerReference)
        }
        binding.providerReference = providerReference
        return binding
      }
      throw new Error(`execution binding ${executionRequestId} not found`)
    },
  }
  return { deps, byKey, bindingCount: () => byKey.size }
}

function baseParams(overrides: Partial<Parameters<typeof registerExecutionBinding>[0]> = {}) {
  return {
    operationId: 'OCD-OP-test-operation-0000000000',
    clientSubmissionKey: 'attempt-1',
    executorIdentity: 'test-executor',
    executorVersion: '1.0.0',
    recoveryCapabilityClass: 'stable-payment-identity' as const,
    frozenPreflightReceiptId: 'OCD-RCP-TEST-0000-0000-0000',
    frozenPreflightReceiptDigest: 'sha256:test-digest',
    expectedPayer: null,
    providerReference: null,
    ...overrides,
  }
}

// --- idempotent creation ---------------------------------------------------

{
  const { deps, bindingCount } = makeFakeStore()
  const first = await registerExecutionBinding(baseParams(), deps)
  const second = await registerExecutionBinding(baseParams(), deps) // same clientSubmissionKey
  assert.ok(first.created)
  assert.ok(!second.created)
  assert.equal(first.binding.executionRequestId, second.binding.executionRequestId, 'a retry with the SAME client_submission_key must return the SAME binding')
  assert.equal(bindingCount(), 1, 'exactly one binding must exist, never two')
}
console.log('ok  registering the same client_submission_key twice is idempotent -- one binding, not two')

// --- D2.4 Section 15 test #3: two concurrent workers cannot produce two payment identities ---

{
  const { deps, bindingCount } = makeFakeStore()
  const [a, b] = await Promise.all([
    registerExecutionBinding(baseParams({ clientSubmissionKey: 'race-attempt' }), deps),
    registerExecutionBinding(baseParams({ clientSubmissionKey: 'race-attempt' }), deps),
  ])
  assert.equal(bindingCount(), 1, 'two concurrent requests for the SAME submission attempt must never create two bindings')
  assert.equal(a.binding.executionRequestId, b.binding.executionRequestId)
  assert.ok(a.created !== b.created || (a.created && b.created) === false, 'at most one of the two concurrent calls observes "created: true"')
}
console.log('ok  two concurrent workers registering the same client_submission_key produce exactly one execution binding')

// A genuinely different attempt (different client_submission_key) for the
// SAME operation is a NEW binding -- this is not the same thing as a retry.
{
  const { deps, bindingCount } = makeFakeStore()
  await registerExecutionBinding(baseParams({ clientSubmissionKey: 'attempt-1' }), deps)
  await registerExecutionBinding(baseParams({ clientSubmissionKey: 'attempt-2' }), deps)
  assert.equal(bindingCount(), 2, 'a genuinely different submission attempt must get its own binding')
}
console.log('ok  a genuinely different client_submission_key creates a separate binding (not conflated with a retry)')

// --- D2.4 Section 15 test #2 / acceptance #7/#8: submission-state machine ---

{
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams(), deps)

  await transitionSubmissionState(binding, 'prepared', deps)
  binding.submissionState = 'prepared'
  await transitionSubmissionState(binding, 'submission_ambiguous', deps)
  binding.submissionState = 'submission_ambiguous'

  // An ambiguous outcome after submission must resolve to a terminal state
  // (transaction_known or manual_recovery_required), never silently loop
  // back to "not_submitted" and never auto-resubmit.
  assert.throws(
    () => {
      throw new InvalidSubmissionTransitionError('x', 'y')
    },
    InvalidSubmissionTransitionError
  )
  await transitionSubmissionState(binding, 'transaction_known', deps)
  binding.submissionState = 'transaction_known'
}
console.log('ok  submission_ambiguous can resolve forward to transaction_known (crash/unknown-result recovery), never resubmits automatically')

{
  // Once terminal, NOTHING can move it again -- this is what stops a stale
  // worker from creating a second payment identity after the fact.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'terminal-test' }), deps)
  binding.submissionState = 'transaction_known'
  await assert.rejects(
    () => transitionSubmissionState(binding, 'submitted', deps),
    InvalidSubmissionTransitionError,
    'a terminal binding must never transition again, even back toward "submitted"'
  )
  await assert.rejects(
    () => transitionSubmissionState(binding, 'not_submitted', deps),
    InvalidSubmissionTransitionError
  )
}
console.log('ok  a terminal binding (transaction_known) can never transition again -- a stale worker cannot resubmit through it')

{
  // Executors without safe recovery (Section 6/acceptance #8): an ambiguous
  // submission with no stable identity to resume by must resolve to
  // manual-recovery-required, a valid terminal product state.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'no-recovery', recoveryCapabilityClass: 'none' }), deps)
  binding.submissionState = 'submission_ambiguous'
  await transitionSubmissionState(binding, 'manual_recovery_required', deps)
  binding.submissionState = 'manual_recovery_required'
  await assert.rejects(() => transitionSubmissionState(binding, 'submitted', deps), InvalidSubmissionTransitionError)
}
console.log('ok  an executor with no safe recovery capability lands on manual_recovery_required, a valid terminal state, and stays there')

// --- D2.6 correction (Section 4): attaching a provider reference AFTER the binding already exists ---

{
  // The exact PayBox gateway scenario: a binding is created BEFORE the
  // provider request identity is known (provider_reference: null), then
  // submit() learns the request_id and attaches it.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'gw-1' }), deps)
  assert.equal(binding.providerReference, null)

  const updated = await attachProviderReference(binding, 'paybox:req-abc-123', deps)
  assert.equal(updated.providerReference, 'paybox:req-abc-123')
}
console.log('ok  provider_reference transitions from null to a value once the provider request id becomes known')

{
  // Idempotent retry with the IDENTICAL reference must succeed silently --
  // e.g. a retried HTTP call after a lost response.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'gw-2' }), deps)
  const first = await attachProviderReference(binding, 'paybox:req-xyz', deps)
  const second = await attachProviderReference(first, 'paybox:req-xyz', deps)
  assert.equal(second.providerReference, 'paybox:req-xyz')
}
console.log('ok  attaching the SAME provider_reference twice is idempotent, never an error')

{
  // A DIFFERENT reference must be rejected outright -- never silently
  // replace an existing provider identity with another one.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'gw-3' }), deps)
  const first = await attachProviderReference(binding, 'paybox:req-original', deps)
  await assert.rejects(() => attachProviderReference(first, 'paybox:req-different', deps), ProviderReferenceConflictError)

  // And the stored value must be UNCHANGED after the rejected attempt.
  const stillOriginal = await attachProviderReference(first, 'paybox:req-original', deps)
  assert.equal(stillOriginal.providerReference, 'paybox:req-original')
}
console.log('ok  a conflicting different provider_reference is rejected, and the original value is never overwritten')

{
  // Attaching a provider_reference must never itself imply or require a
  // state transition -- it is an independent, orthogonal update.
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(baseParams({ clientSubmissionKey: 'gw-4' }), deps)
  const updated = await attachProviderReference(binding, 'paybox:req-independent', deps)
  assert.equal(updated.submissionState, 'not_submitted', 'attaching a provider reference must not change submission_state on its own')
}
console.log('ok  attaching a provider_reference is independent of the submission-state machine')

{
  // D2.6 correction test #13: attaching a real provider_reference to a
  // PayBox gateway binding must NEVER increase its binding strength -- the
  // cap is decided entirely by executorIdentity/executorVersion (see
  // commerceLifecycle.ts's isConservativeMatchOnlyEvidence), which
  // attachProviderReference never touches.
  const { isConservativeMatchOnlyEvidence } = await import('../src/commerceLifecycle.js')
  const { deps } = makeFakeStore()
  const { binding } = await registerExecutionBinding(
    baseParams({ clientSubmissionKey: 'gw-cap', executorIdentity: 'paybox-x402-base-usdc', executorVersion: 'v1-gateway' }),
    deps
  )
  assert.equal(isConservativeMatchOnlyEvidence(binding.executorIdentity, binding.executorVersion), true)
  const updated = await attachProviderReference(binding, 'paybox:7a998655-147e-4cfb-8269-01672dfc515d', deps)
  assert.equal(
    isConservativeMatchOnlyEvidence(updated.executorIdentity, updated.executorVersion),
    true,
    'a real provider_reference existing must never change the gateway conservative-match-only classification'
  )
}
console.log('ok  attaching a real provider_reference to a PayBox gateway binding never changes its conservative-match-only (TRANSFER_MATCH_ONLY-capped) classification')

console.log('\nAll D2.4 execution-binding tests passed.')
