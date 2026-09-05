/**
 * executionBinding.ts — durable execution/payment binding (D2.4, Section 6).
 *
 * Created BEFORE any potentially mutating submission, so a crash between
 * "we're about to submit" and "we know what happened" always has a durable
 * row to resume from instead of silently guessing. `client_submission_key`
 * (chosen by the executor/caller, opaque) is what makes creating a binding
 * itself idempotent — see db.ts's createExecutionBinding for the exact
 * concurrency mechanism (a unique constraint + INSERT ... ON CONFLICT DO
 * NOTHING, identical in shape to every other idempotent write in this
 * codebase).
 *
 * `recovery_capability_class` records, honestly, whether the executor CAN
 * safely identify and resume its own submission attempt:
 *   - 'stable-payment-identity': the executor's payment mechanism itself has
 *     a stable identity across retries (e.g. an EIP-3009 nonce chosen once
 *     and reused) -- a lost response is recoverable by querying that identity.
 *   - 'provider-idempotent': the executor's provider deduplicates retries by
 *     its own idempotency key.
 *   - 'none': neither is true. This does not mean OCD refuses to proceed --
 *     it means an ambiguous outcome for this binding MUST resolve to
 *     'manual-recovery-required' rather than a silent resubmission (Section
 *     7/12): "It is preferable to pretending exactly-once execution can be
 *     guaranteed."
 */
import { randomBytes } from 'node:crypto'
import {
  createExecutionBinding as dbCreateExecutionBinding,
  getExecutionBinding as dbGetExecutionBinding,
  updateExecutionBindingSubmissionState as dbUpdateSubmissionState,
  type ExecutionBindingRecord,
} from './db.js'

export type SubmissionState =
  | 'not_submitted'
  | 'prepared'
  | 'submission_ambiguous'
  | 'submitted'
  | 'outcome_unknown'
  | 'transaction_known'
  | 'manual_recovery_required'

const TERMINAL_STATES: ReadonlySet<SubmissionState> = new Set(['transaction_known', 'manual_recovery_required'])

export function isTerminalSubmissionState(state: string): boolean {
  return TERMINAL_STATES.has(state as SubmissionState)
}

/**
 * The state transitions this module allows. Deliberately NOT a total order:
 * 'submission_ambiguous' -> 'submitted' is allowed (the ambiguous attempt
 * turned out to have gone through once resolved), but nothing may transition
 * OUT of a terminal state (Section 7: "never automatically create a new
 * payment identity"). A caller that needs to represent a genuinely NEW
 * attempt must create a NEW binding (a new client_submission_key), never
 * repurpose a terminal one.
 */
const ALLOWED_TRANSITIONS: Record<SubmissionState, ReadonlySet<SubmissionState>> = {
  not_submitted: new Set(['prepared', 'submission_ambiguous', 'submitted', 'manual_recovery_required']),
  prepared: new Set(['submission_ambiguous', 'submitted', 'manual_recovery_required']),
  submission_ambiguous: new Set(['submitted', 'outcome_unknown', 'transaction_known', 'manual_recovery_required']),
  outcome_unknown: new Set(['transaction_known', 'manual_recovery_required']),
  submitted: new Set(['transaction_known', 'outcome_unknown', 'manual_recovery_required']),
  transaction_known: new Set([]),
  manual_recovery_required: new Set([]),
}

export class InvalidSubmissionTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`cannot transition execution binding submission_state from "${from}" to "${to}"`)
    this.name = 'InvalidSubmissionTransitionError'
  }
}

function generateExecutionRequestId(): string {
  return 'OCD-EXEC-' + randomBytes(16).toString('base64url')
}

export interface CreateExecutionBindingParams {
  operationId: string
  clientSubmissionKey: string
  executorIdentity: string
  executorVersion: string
  recoveryCapabilityClass: ExecutionBindingRecord['recoveryCapabilityClass']
  frozenPreflightReceiptId: string
  frozenPreflightReceiptDigest: string
  expectedPayer: string | null
  providerReference: string | null
}

export interface ExecutionBindingDependencies {
  createExecutionBinding?: typeof dbCreateExecutionBinding
  getExecutionBinding?: typeof dbGetExecutionBinding
  updateExecutionBindingSubmissionState?: typeof dbUpdateSubmissionState
}

/** Idempotent: retrying with the SAME clientSubmissionKey always returns the SAME binding (created: false), never a second one. */
export async function registerExecutionBinding(
  params: CreateExecutionBindingParams,
  deps: ExecutionBindingDependencies = {}
): Promise<{ created: boolean; binding: ExecutionBindingRecord }> {
  return (deps.createExecutionBinding ?? dbCreateExecutionBinding)({ ...params, executionRequestId: generateExecutionRequestId() })
}

export async function getExecutionBinding(
  executionRequestId: string,
  deps: ExecutionBindingDependencies = {}
): Promise<ExecutionBindingRecord | null> {
  return (deps.getExecutionBinding ?? dbGetExecutionBinding)(executionRequestId)
}

/**
 * Applies a submission-state transition, rejecting anything not in
 * ALLOWED_TRANSITIONS -- in particular, rejecting any attempt to move a
 * binding OUT of a terminal state, which is what stops a stale worker from
 * ever resubmitting through a binding that already reached a definitive (or
 * definitively-unrecoverable) outcome.
 */
export async function transitionSubmissionState(
  binding: ExecutionBindingRecord,
  to: SubmissionState,
  deps: ExecutionBindingDependencies = {}
): Promise<void> {
  const from = binding.submissionState as SubmissionState
  if (from === to) return // idempotent no-op, not an error
  if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
    throw new InvalidSubmissionTransitionError(from, to)
  }
  await (deps.updateExecutionBindingSubmissionState ?? dbUpdateSubmissionState)(binding.executionRequestId, to)
}
