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
import { updateCommerceOperationState, getReceiptForFinalization, type CommerceOperationRecord } from './db.js'
import {
  registerExecutionBinding,
  getExecutionBinding,
  transitionSubmissionState,
  type SubmissionState,
} from './executionBinding.js'
import { recordObservation, selectExactTransfer } from './commerceObservation.js'
import { buildPreflightCommitment, type PreflightCommitment } from './commerceLifecycle.js'
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
    if (!isPlainObject(body) || typeof body.state !== 'string' || !SUBMISSION_STATES.has(body.state)) {
      return c.json({ error: `state must be one of: ${[...SUBMISSION_STATES].join(', ')}` }, 400)
    }

    try {
      await transitionSubmissionState(binding, body.state as SubmissionState)
    } catch (err: any) {
      return c.json({ error: err?.message || 'invalid state transition' }, 409)
    }
    await updateCommerceOperationState(operationId, { executionState: body.state as CommerceOperationRecord['executionState'] })
    return c.json({ execution_request_id: executionRequestId, submission_state: body.state })
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

    let legacyResult
    try {
      legacyResult = await finalizePayment(authHeader, rawBody, deps.finalize)
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

    const frozenStep = await getStepState(operationId, 'preflight', deps.step)
    if (!frozenStep || frozenStep.status !== 'completed') {
      // The receipt WAS legitimately finalized (legacy behavior above is
      // unaffected) — but without this operation's own frozen preflight
      // input, the D2.4 evidence layer cannot be reconstructed. Report the
      // legacy result anyway rather than discarding a successful, paid-for
      // finalization; only the extra evidence is unavailable.
      return c.json({ ...envelope, ocd_lifecycle_evidence: null, ocd_lifecycle_note: 'operation has no completed preflight step on record; D2.4 evidence not attached' })
    }
    const frozen = frozenStep.frozenInput as FrozenPreflightInput

    let binding = null
    if (executionRequestId) {
      binding = await getExecutionBinding(executionRequestId)
      if (!binding || binding.operationId !== operationId) {
        return c.json({ error: 'execution_request_id does not belong to this operation' }, 400)
      }
    }

    const preflightReceiptId = envelope.receipt.links.preflight_receipt_id
    const preflightReceiptDigest = envelope.receipt.checks.find((chk) => chk.id === 'preflight-receipt-valid')?.evidence_digest ?? ''
    const commitment = reconstructPreflightCommitment(frozen, preflightReceiptId, preflightReceiptDigest)

    const parsedExecution = parseFinalizationExecutionInput(rawBody)
    let observation
    try {
      observation = await observeTransaction(parsedExecution.transaction_hash, frozen.input.action.network ?? BASE_CAIP2, frozen.input.action.asset ?? '')
    } catch {
      observation = null
    }

    const transferFieldsMatch = envelope.receipt.checks.find((chk) => chk.id === 'execution-matches-preflight')?.result === 'PASS'
    const selectedTransfer = observation && observation.state === 'success' ? selectExactTransfer(observation.transfers, frozen.input.action.recipient) : null

    let evidence = null
    if (observation) {
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
      await updateCommerceOperationState(operationId, { observationState: 'confirmed', receiptState: 'commerce_issued' })
    }

    return c.json({ ...envelope, ocd_lifecycle_evidence: evidence })
  }
}

export function mountLifecycleFinalize(app: Hono, deps: LifecycleFinalizeDependencies = {}): void {
  app.post('/operations/:operationId/execution-bindings', createExecutionBindingsHandler(deps))
  app.post('/operations/:operationId/execution-bindings/:executionRequestId/state', createExecutionBindingStateHandler(deps))
  app.post('/operations/:operationId/finalize', createOperationFinalizeHandler(deps))
}
