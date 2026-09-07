/**
 * operationHistory.ts — D2.7A read model for the authenticated private
 * operation history + recovery center.
 *
 * Builds on EXISTING D2.4 tables/queries only (commerce_operations,
 * execution_bindings, commerce_observations, receipts) plus the new D2.7A
 * owner_id column and accounts table -- no new lifecycle semantics, no new
 * binding-strength/settlement logic. `deriveRecoveryStatus()` is a pure
 * function over already-existing, already-typed state (the same
 * execution_state/observation_state/receipt_state enums the D2.4 route
 * layer already returns) -- it reads recovery semantics, it does not invent
 * them.
 *
 * Never returns: recovery_credential(_hash), capability_token, or anything
 * from finalization_capabilities beyond the one non-secret column
 * (commerce_receipt_id) already exposed by getCommerceReceiptIdForPreflightReceipt().
 */
import {
  getCommerceOperation,
  getExecutionBindingsForOperation,
  listCommerceObservations,
  listCommerceOperationsForOwner,
  getCommerceReceiptIdForPreflightReceipt,
  getReceiptForFinalization,
  type CommerceOperationRecord,
  type ExecutionBindingRecord,
  type CommerceObservationRecord,
} from './db.js'
import { verifyReceipt } from './receiptTools.js'
import type { PublicActionReceiptEnvelope } from './receipts.js'

export interface OperationSummary {
  operation_id: string
  created_at: string
  preflight_state: CommerceOperationRecord['preflightState']
  execution_state: CommerceOperationRecord['executionState']
  observation_state: CommerceOperationRecord['observationState']
  receipt_state: CommerceOperationRecord['receiptState']
  preflight_receipt_id: string | null
  commerce_receipt_id: string | null
}

function toSummary(op: CommerceOperationRecord, commerceReceiptId: string | null): OperationSummary {
  return {
    operation_id: op.operationId,
    created_at: op.createdAt,
    preflight_state: op.preflightState,
    execution_state: op.executionState,
    observation_state: op.observationState,
    receipt_state: op.receiptState,
    preflight_receipt_id: op.preflightReceiptId,
    commerce_receipt_id: commerceReceiptId,
  }
}

/** Bounded recent history, newest first. No filtering beyond ownership (Section 2: keep this slice simple). */
export async function listOperationsForOwner(ownerId: string, options: { limit?: number; before?: string } = {}): Promise<OperationSummary[]> {
  const ops = await listCommerceOperationsForOwner(ownerId, options)
  const summaries: OperationSummary[] = []
  for (const op of ops) {
    const commerceReceiptId = op.preflightReceiptId ? await getCommerceReceiptIdForPreflightReceipt(op.preflightReceiptId) : null
    summaries.push(toSummary(op, commerceReceiptId))
  }
  return summaries
}

export interface RecoveryStatus {
  /** True whenever an operator should look at this operation -- ambiguous, stalled, or otherwise not cleanly finished. */
  needsAttention: boolean
  /** True whenever a real payment/provider action may already have happened -- the operator-facing UI must never suggest "just try again" when this is true. */
  mayAlreadyHavePaid: boolean
  /** What is currently known, in plain language. */
  summary: string
  /** The one safe next action -- never "retry payment" or "resubmit" when mayAlreadyHavePaid is true. */
  safeNextAction: string
}

/**
 * Pure function, no I/O: maps the EXISTING D2.4 state machine
 * (execution_state / observation_state / receipt_state, plus the bindings
 * already fetched for this operation) to an operator-facing recovery
 * status. Deliberately conservative: only the fully-issued-receipt state is
 * ever reported as "does not need attention" among completed submissions --
 * everything else that looks like it might be mid-flight or stuck is
 * flagged rather than silently treated as fine.
 */
export function deriveRecoveryStatus(op: CommerceOperationRecord, bindings: ExecutionBindingRecord[], observations: CommerceObservationRecord[]): RecoveryStatus {
  if (op.receiptState === 'commerce_issued') {
    return {
      needsAttention: false,
      mayAlreadyHavePaid: true,
      summary: 'A Commerce receipt has been issued for this operation.',
      safeNextAction: 'None -- this operation is complete.',
    }
  }

  if (op.observationState === 'contradicted') {
    return {
      needsAttention: true,
      mayAlreadyHavePaid: true,
      summary: 'A later on-chain observation contradicted an earlier one recorded for this operation.',
      safeNextAction: 'Manual investigation required. Do not finalize automatically and do not attempt a new payment.',
    }
  }

  const latestBinding = bindings.length > 0 ? bindings[bindings.length - 1] : null

  switch (op.executionState) {
    case 'manual_recovery_required':
      return {
        needsAttention: true,
        mayAlreadyHavePaid: true,
        summary: 'The executor reported that this operation requires manual recovery.',
        safeNextAction: 'Investigate directly with the payment provider before doing anything else. Do not create a new payment attempt for the same intent.',
      }
    case 'submission_ambiguous':
      return {
        needsAttention: true,
        mayAlreadyHavePaid: true,
        summary: 'A submission attempt was made but its outcome is not yet known.',
        safeNextAction: 'Resume this exact operation (same executor, same client_submission_key) to check whether it already went through. Never retry it as a new payment.',
      }
    case 'outcome_unknown':
      return {
        needsAttention: true,
        mayAlreadyHavePaid: true,
        summary: 'The provider outcome for this submission could not be determined.',
        safeNextAction: 'Resume this exact operation to re-check the outcome.',
      }
    case 'transaction_known':
      return {
        needsAttention: true,
        mayAlreadyHavePaid: true,
        summary: latestBinding?.providerReference
          ? `A transaction is known (provider reference ${latestBinding.providerReference}) but this operation has not yet been finalized into a receipt.`
          : 'A transaction is known but this operation has not yet been finalized into a receipt.',
        safeNextAction: 'Call observe/finalize again for this operation. Never resubmit payment -- the transaction is already known.',
      }
    case 'prepared':
      return {
        needsAttention: true,
        mayAlreadyHavePaid: false,
        summary: 'Execution was prepared but has not yet been submitted.',
        safeNextAction: 'Resume this operation to submit, or investigate why it stalled before submission ever happened.',
      }
    case 'submitted':
      return {
        needsAttention: false,
        mayAlreadyHavePaid: true,
        summary: 'Execution was submitted; the outcome is still being awaited.',
        safeNextAction: 'Resume shortly to check for an outcome.',
      }
    case 'not_submitted':
    default:
      if (op.preflightState === 'completed') {
        return {
          needsAttention: true,
          mayAlreadyHavePaid: false,
          summary: 'Preflight completed (a decision was reached) but execution was never attempted.',
          safeNextAction: 'Resume this operation to execute, if the decision allows it -- or take no action if it does not.',
        }
      }
      return {
        needsAttention: false,
        mayAlreadyHavePaid: false,
        summary: 'Preflight has not completed yet.',
        safeNextAction: 'None yet -- this operation is still early in its lifecycle.',
      }
  }
}

export interface OperationDetail extends OperationSummary {
  preflight_receipt: PublicActionReceiptEnvelope | null
  execution_bindings: Array<{
    execution_request_id: string
    client_submission_key: string
    executor_identity: string
    executor_version: string
    recovery_capability_class: ExecutionBindingRecord['recoveryCapabilityClass']
    provider_reference: string | null
    submission_state: string
    expected_payer: string | null
  }>
  observations: Array<{
    observation_id: string
    network: string
    block_hash: string
    block_number: string
    transaction_hash: string
    log_index: number
    observed_payer: string | null
    observed_recipient: string | null
    observed_amount_atomic: string | null
    token_contract: string
    finality_state: string
    binding_strength: CommerceObservationRecord['bindingStrength']
    bundle_digest: string | null
    observed_at?: string
  }>
  commerce_receipt: PublicActionReceiptEnvelope | null
  commerce_receipt_verification: { state: string; code: string; message: string } | null
  recovery: RecoveryStatus
}

export type OperationDetailResult = { found: true; detail: OperationDetail } | { found: false }

/**
 * Ownership is checked here, once, before anything is assembled or
 * returned: a mismatched or absent owner produces the exact same
 * `{found: false}` as a genuinely unknown operation_id -- no distinguishing
 * "exists but isn't yours" from "doesn't exist" (same discipline as
 * authenticateOperation()'s own indistinguishable failure modes).
 */
export async function getOperationDetailForOwner(operationId: string, ownerId: string): Promise<OperationDetailResult> {
  const op = await getCommerceOperation(operationId)
  if (!op || op.ownerId !== ownerId) return { found: false }

  const [bindings, observations] = await Promise.all([getExecutionBindingsForOperation(operationId), listCommerceObservations(operationId)])

  const preflightReceipt = op.preflightReceiptId ? await getReceiptForFinalization(op.preflightReceiptId) : null
  const commerceReceiptId = op.preflightReceiptId ? await getCommerceReceiptIdForPreflightReceipt(op.preflightReceiptId) : null
  const commerceReceiptStored = commerceReceiptId ? await getReceiptForFinalization(commerceReceiptId) : null
  const commerceReceiptVerification = commerceReceiptStored ? await verifyReceipt({ envelope: commerceReceiptStored.envelope }) : null

  let recovery = deriveRecoveryStatus(op, bindings, observations)
  // A receipt that exists but does not independently verify VALID is, by
  // definition, something an operator needs to look at -- override the
  // otherwise-"complete" verdict rather than silently reporting success.
  if (op.receiptState === 'commerce_issued' && commerceReceiptVerification && commerceReceiptVerification.state !== 'VALID') {
    recovery = {
      needsAttention: true,
      mayAlreadyHavePaid: true,
      summary: `A Commerce receipt exists for this operation but does not independently verify VALID (${commerceReceiptVerification.state}: ${commerceReceiptVerification.code}).`,
      safeNextAction: 'Manual investigation required. Do not treat this operation as complete until the receipt verifies VALID.',
    }
  }

  return {
    found: true,
    detail: {
      ...toSummary(op, commerceReceiptId),
      preflight_receipt: preflightReceipt?.envelope ?? null,
      execution_bindings: bindings.map((b) => ({
        execution_request_id: b.executionRequestId,
        client_submission_key: b.clientSubmissionKey,
        executor_identity: b.executorIdentity,
        executor_version: b.executorVersion,
        recovery_capability_class: b.recoveryCapabilityClass,
        provider_reference: b.providerReference,
        submission_state: b.submissionState,
        expected_payer: b.expectedPayer,
      })),
      observations: observations.map((o) => ({
        observation_id: o.observationId,
        network: o.network,
        block_hash: o.blockHash,
        block_number: o.blockNumber,
        transaction_hash: o.transactionHash,
        log_index: o.logIndex,
        observed_payer: o.observedPayer,
        observed_recipient: o.observedRecipient,
        observed_amount_atomic: o.observedAmountAtomic,
        token_contract: o.tokenContract,
        finality_state: o.finalityState,
        binding_strength: o.bindingStrength,
        bundle_digest: o.bundleDigest,
      })),
      commerce_receipt: commerceReceiptStored?.envelope ?? null,
      commerce_receipt_verification: commerceReceiptVerification,
      recovery,
    },
  }
}
