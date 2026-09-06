/**
 * lifecycleFinalizeRoute.ts — execution bindings + operation-bound finalize
 * (D2.4, Sections 6-10).
 *
 * ADDITIVE, layered on top of the completely unchanged legacy
 * /receipts/finalize (finalizeRoute.ts): this module calls finalizePayment()
 * internally to do the actual capability consumption + Commerce Receipt
 * build (the exact same proven, single-use-capability, atomically-consumed
 * logic — nothing about that is reimplemented or weakened here), then
 * layers the D2.4 exact-observation + finality + binding-strength evidence
 * on top as an ADDITIONAL step, using a second (read-only, side-effect-free)
 * chain inspection so finalizeRoute.ts itself never needs to change.
 *
 * SCOPE NOTE: the existing finalization_capabilities model is single-use —
 * one preflight receipt authorizes creating exactly one Commerce Receipt,
 * ever (a second transaction hash after consumption is rejected as
 * 'consumed-different-tx'). That means true multi-observation append-only
 * behavior for ONE operation (Section 10) is only reachable today through
 * the existing, separate, already-proven D2.2B2 reconciliation script — not
 * through this endpoint, which can only ever produce one observation row
 * per operation via the normal path. `commerce_observations`' append-only
 * DB mechanism itself (the unique constraint on exact event identity) is
 * still real and independently tested; wiring the reconciliation script
 * into this same evidence layer is left for a later milestone.
 */
import type { Context, Hono } from 'hono'
import { authenticateOperation } from './operation.js'
import { getStepState, type LifecycleStepDependencies } from './lifecycleSteps.js'
import { updateCommerceOperationState, getCommerceOperation, getReceiptForFinalization, type CommerceOperationRecord } from './db.js'
import {
  registerExecutionBinding,
  getExecutionBinding,
  transitionSubmissionState,
  attachProviderReference,
  ProviderReferenceConflictError,
  type SubmissionState,
} from './executionBinding.js'
import { recordObservation, selectExactTransfer } from './commerceObservation.js'
import { buildPreflightCommitment, type PreflightCommitment } from './commerceLifecycle.js'
import { buildCommerceReceiptCore } from './commerceReceipt.js'
import { finalizePayment, parseFinalizationExecutionInput, FinalizationAuthError, FinalizationInputError, FinalizationConflictError, FinalizationPendingError, type FinalizeDependencies } from './finalizeRoute.js'
import { finalizationTtlHours } from './capability.js'
import { observeTransaction, getSupportedAsset, getClient, BASE_CAIP2 } from './settlement.js'
import { decimalAmountToAtomicUnits } from './money.js'
import type { PreflightInput } from './preflight.js'

const RECOVERY_HEADER = 'x-ocd-recovery-credential'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface FrozenPreflightInput {
  input: PreflightInput
  issuedAt: string
}

function reconstructPreflightCommitment(
  frozen: FrozenPreflightInput,
  preflightReceiptId: string,
  preflightReceiptDigest: string
): PreflightCommitment {
  const { action, policy, options } = frozen.input
  const asset = getSupportedAsset(action.network, action.asset)
  const amountAtomic = asset ? decimalAmountToAtomicUnits(action.amount, asset.decimals) : null
  const executionValidUntil = new Date(new Date(frozen.issuedAt).getTime() + finalizationTtlHours() * 3600 * 1000).toISOString()
  const commitment = buildPreflightCommitment({
    action,
    policy,
    screenRecipientSanctions: options.screen_recipient_sanctions,
    evidenceRefs: [preflightReceiptDigest],
    amountAtomic: amountAtomic !== null ? amountAtomic.toString() : null,
    issuedAt: frozen.issuedAt,
    executionValidUntil,
  })
  return commitment
}

// ---------------------------------------------------------------------
// POST /operations/:operationId/execution-bindings
// ---------------------------------------------------------------------

export interface LifecycleFinalizeDependencies {
  authenticateOperation?: typeof authenticateOperation
  step?: LifecycleStepDependencies
  finalize?: FinalizeDependencies
}

export function createExecutionBindingsHandler(deps: LifecycleFinalizeDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const credential = c.req.header(RECOVERY_HEADER)
    const op: CommerceOperationRecord | null = await (deps.authenticateOperation ?? authenticateOperation)(operationId, credential)
    if (!op) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }
    if (!op.preflightReceiptId) {
      return c.json({ error: 'this operation has no completed preflight step yet -- call POST /x402/lifecycle/preflight-payment first' }, 409)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    if (!isPlainObject(body)) return c.json({ error: 'body must be a JSON object' }, 400)

    const clientSubmissionKey = body.client_submission_key
    if (typeof clientSubmissionKey !== 'string' || clientSubmissionKey.length === 0 || clientSubmissionKey.length > 200) {
      return c.json({ error: 'client_submission_key must be a non-empty string (max 200 chars)' }, 400)
    }
    const executorIdentity = body.executor_identity
    const executorVersion = body.executor_version
    if (typeof executorIdentity !== 'string' || executorIdentity.length === 0) return c.json({ error: 'executor_identity must be a non-empty string' }, 400)
    if (typeof executorVersion !== 'string' || executorVersion.length === 0) return c.json({ error: 'executor_version must be a non-empty string' }, 400)
    const recoveryCapabilityClass = body.recovery_capability_class
    if (recoveryCapabilityClass !== 'provider-idempotent' && recoveryCapabilityClass !== 'stable-payment-identity' && recoveryCapabilityClass !== 'none') {
      return c.json({ error: 'recovery_capability_class must be one of: provider-idempotent, stable-payment-identity, none' }, 400)
    }
    const expectedPayer = body.expected_payer
    if (expectedPayer !== undefined && expectedPayer !== null && (typeof expectedPayer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(expectedPayer))) {
      return c.json({ error: 'expected_payer must be a 0x EVM address, or null' }, 400)
    }
    const providerReference = body.provider_reference
    if (providerReference !== undefined && providerReference !== null && typeof providerReference !== 'string') {
      return c.json({ error: 'provider_reference must be a string, or null' }, 400)
    }

    const preflightStored = await getReceiptForFinalization(op.preflightReceiptId)
    if (!preflightStored) return c.json({ error: 'the bound preflight receipt could not be located' }, 500)

    const { created, binding } = await registerExecutionBinding({
      operationId,
      clientSubmissionKey,
      executorIdentity,
      executorVersion,
      recoveryCapabilityClass,
      frozenPreflightReceiptId: op.preflightReceiptId,
      frozenPreflightReceiptDigest: preflightStored.envelope.receipt.receipt_digest,
      expectedPayer: expectedPayer ?? null,
      providerReference: providerReference ?? null,
    })

    await updateCommerceOperationState(operationId, { executionState: created ? 'prepared' : op.executionState })

    return c.json(
      {
        execution_request_id: binding.executionRequestId,
        submission_state: binding.submissionState,
        idempotent_replay: !created,
      },
      created ? 201 : 200
    )
  }
}

const SUBMISSION_STATES: ReadonlySet<string> = new Set([
  'not_submitted',
  'prepared',
  'submission_ambiguous',
  'submitted',
  'outcome_unknown',
  'transaction_known',
  'manual_recovery_required',
])

export function createExecutionBindingStateHandler(deps: LifecycleFinalizeDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const executionRequestId = c.req.param('executionRequestId') ?? ''
    const credential = c.req.header(RECOVERY_HEADER)
    const op = await (deps.authenticateOperation ?? authenticateOperation)(operationId, credential)
    if (!op) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }
    const binding = await getExecutionBinding(executionRequestId)
    if (!binding || binding.operationId !== operationId) return c.json({ error: 'unknown execution binding for this operation' }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    if (!isPlainObject(body)) return c.json({ error: 'body must be a JSON object' }, 400)

    const hasState = body.state !== undefined
    const hasProviderReference = body.provider_reference !== undefined
    if (!hasState && !hasProviderReference) {
      return c.json({ error: 'body must include at least one of: state, provider_reference' }, 400)
    }
    if (hasState && (typeof body.state !== 'string' || !SUBMISSION_STATES.has(body.state))) {
      return c.json({ error: `state must be one of: ${[...SUBMISSION_STATES].join(', ')}` }, 400)
    }
    if (hasProviderReference && (typeof body.provider_reference !== 'string' || body.provider_reference.length === 0)) {
      return c.json({ error: 'provider_reference must be a non-empty string' }, 400)
    }

    // D2.6 correction (Section 4): attach the provider's request identity to
    // this ALREADY-EXISTING binding BEFORE applying any state transition --
    // an executor whose provider action happens in submit() (e.g. PayBox
    // gateway mode) learns its request_id only after the binding was
    // created with provider_reference: null. One-way (null -> a value),
    // idempotent on retry with the identical value, rejected on conflict.
    let currentBinding = binding
    if (hasProviderReference) {
      try {
        currentBinding = await attachProviderReference(binding, body.provider_reference as string)
      } catch (err: any) {
        if (err instanceof ProviderReferenceConflictError) return c.json({ error: err.message }, 409)
        throw err
      }
    }

    if (hasState) {
      try {
        await transitionSubmissionState(currentBinding, body.state as SubmissionState)
      } catch (err: any) {
        return c.json({ error: err?.message || 'invalid state transition' }, 409)
      }
      await updateCommerceOperationState(operationId, { executionState: body.state as CommerceOperationRecord['executionState'] })
    }
    return c.json({ execution_request_id: executionRequestId, submission_state: hasState ? body.state : currentBinding.submissionState, provider_reference: currentBinding.providerReference })
  }
}

// ---------------------------------------------------------------------
// POST /operations/:operationId/finalize
// ---------------------------------------------------------------------

export function createOperationFinalizeHandler(deps: LifecycleFinalizeDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const authHeader = c.req.header('authorization')

    let rawBody: unknown
    try {
      rawBody = await c.req.raw.clone().json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    const body = isPlainObject(rawBody) ? rawBody : {}
    const executionRequestId = typeof body.execution_request_id === 'string' ? body.execution_request_id : null

    // Validated strictly up front, before ANY evidence computation or state
    // mutation (including finalizePayment() itself): an execution_request_id
    // that doesn't belong to this operation must never be silently treated
    // as "no binding" and allowed to proceed -- that would let a caller-
    // supplied mismatched id durably pollute the append-only observation
    // table with evidence computed under the wrong executor-correlation
    // assumption for a request that should have been rejected outright.
    let binding = null
    if (executionRequestId) {
      binding = await getExecutionBinding(executionRequestId)
      if (!binding || binding.operationId !== operationId) {
        return c.json({ error: 'execution_request_id does not belong to this operation' }, 400)
      }
    }

    // D2.5A fix: compute the D2.4 lifecycle evidence bundle BEFORE calling
    // finalizePayment(), so its digest can be committed into the new
    // receipt's own links.agent_evidence_bundle_digest field before it is
    // signed -- never bolted on afterward as an unsigned sibling property
    // on the HTTP response (confirmed live defect: the signed receipt's own
    // content always carried agent_evidence_bundle_digest: null, and there
    // was no way to retroactively fix an already-signed receipt). Only
    // possible when this operation actually has a completed preflight step
    // on record; when it doesn't, this degrades to exactly the same
    // fallback behavior as before -- legacy finalize is never blocked on
    // the evidence layer. See finalizeRoute.ts's FinalizePaymentOptions.
    let noEvidenceNote: string | null = null
    let evidence: { bundle_digest: string; binding_strength: string } | null = null
    let agentEvidenceBundleDigest: string | null = null

    const op = await getCommerceOperation(operationId)
    const frozenStep = op ? await getStepState(operationId, 'preflight', deps.step) : null
    if (!op || !op.preflightReceiptId || !frozenStep || frozenStep.status !== 'completed') {
      noEvidenceNote = 'operation has no completed preflight step on record; D2.4 evidence not attached'
    } else {
      const frozen = frozenStep.frozenInput as FrozenPreflightInput
      const preflightReceiptId = op.preflightReceiptId
      const preflightStored = await getReceiptForFinalization(preflightReceiptId)
      let parsedExecution: ReturnType<typeof parseFinalizationExecutionInput> | null = null
      try {
        parsedExecution = parseFinalizationExecutionInput(rawBody)
      } catch {
        // Invalid input -- finalizePayment() below will parse it again and
        // report the real FinalizationInputError; nothing to precompute here.
        parsedExecution = null
      }

      if (preflightStored && preflightStored.envelope.receipt.receipt_type === 'PREFLIGHT' && parsedExecution) {
        const preflightReceipt = preflightStored.envelope.receipt
        const preflightReceiptDigest = preflightReceipt.receipt_digest
        const commitment = reconstructPreflightCommitment(frozen, preflightReceiptId, preflightReceiptDigest)

        let observation
        try {
          observation = await observeTransaction(parsedExecution.transaction_hash, frozen.input.action.network ?? BASE_CAIP2, frozen.input.action.asset ?? '')
        } catch {
          observation = null
        }

        if (observation) {
          // Pure, side-effect-free: independently derives the SAME
          // execution-matches-preflight verdict finalizePayment() will
          // derive moments later for the signed receipt itself, without
          // waiting for that receipt to exist first.
          const built = buildCommerceReceiptCore(preflightReceipt, parsedExecution, observation)
          const transferFieldsMatch = built.checks.find((chk) => chk.id === 'execution-matches-preflight')?.result === 'PASS'
          const selectedTransfer = observation.state === 'success' ? selectExactTransfer(observation.transfers, frozen.input.action.recipient) : null

          const result = await recordObservation({
            operationId,
            network: frozen.input.action.network,
            observation,
            selectedTransfer,
            expectedPayer: frozen.input.policy.expected_payer,
            transferFieldsMatch,
            executionBinding: binding,
            preflightReceiptId,
            preflightReceiptDigest,
            preflightCommitment: commitment,
            tokenContract: frozen.input.action.asset,
            finalityClient: observation.state === 'success' ? getClient() : null,
            priorObservation: null,
          })
          evidence = { bundle_digest: result.bundleDigest, binding_strength: result.bindingStrength }
          agentEvidenceBundleDigest = result.bundleDigest
        }
      }
    }

    let legacyResult
    try {
      legacyResult = await finalizePayment(authHeader, rawBody, deps.finalize, { agentEvidenceBundleDigest })
    } catch (err: any) {
      if (err instanceof FinalizationAuthError) {
        c.header('WWW-Authenticate', 'Bearer realm="finalization"')
        return c.json({ error: err.message }, 401)
      }
      if (err instanceof FinalizationInputError) return c.json({ error: err.message }, 400)
      if (err instanceof FinalizationConflictError) return c.json({ error: err.message }, 409)
      if (err instanceof FinalizationPendingError) {
        c.header('Retry-After', String(err.retryAfterSeconds))
        return c.json({ error: err.message, reason: err.reason }, err.httpStatus)
      }
      return c.json({ error: err?.message || 'finalization failed' }, 502)
    }

    const envelope = legacyResult.envelope
    if (envelope.receipt.links.preflight_receipt_id === null) {
      return c.json({ error: 'finalized receipt carries no preflight link -- cannot attach operation-bound evidence' }, 500)
    }

    if (!evidence) {
      // The receipt WAS legitimately finalized (legacy behavior above is
      // unaffected) — but the D2.4 evidence layer could not be attached
      // this time (no completed preflight step on record, or a transient
      // failure computing the evidence bundle). Report the legacy result
      // anyway rather than discarding a successful, paid-for finalization;
      // only the extra evidence is unavailable.
      return c.json({ ...envelope, ocd_lifecycle_evidence: null, ...(noEvidenceNote ? { ocd_lifecycle_note: noEvidenceNote } : {}) })
    }

    // D2.5A: a known, independently-confirmed execution must not be left
    // reading execution_state: "prepared" forever -- the client's own
    // mirror update (execution-bindings/:id/state) is best-effort and can
    // silently fail; this is the point where the server itself definitively
    // knows the outcome, so it sets the authoritative state directly.
    await updateCommerceOperationState(operationId, { observationState: 'confirmed', receiptState: 'commerce_issued', executionState: 'transaction_known' })

    return c.json({ ...envelope, ocd_lifecycle_evidence: evidence })
  }
}

export function mountLifecycleFinalize(app: Hono, deps: LifecycleFinalizeDependencies = {}): void {
  app.post('/operations/:operationId/execution-bindings', createExecutionBindingsHandler(deps))
  app.post('/operations/:operationId/execution-bindings/:executionRequestId/state', createExecutionBindingStateHandler(deps))
  app.post('/operations/:operationId/finalize', createOperationFinalizeHandler(deps))
}
