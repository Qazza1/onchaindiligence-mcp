/**
 * lifecycleRoute.ts — D2.4 operation-bound HTTP surface.
 *
 * Everything here is ADDITIVE. The legacy /x402/preflight-payment and
 * /receipts/finalize routes (preflight.ts / finalizeRoute.ts) are completely
 * unchanged and keep working exactly as before for existing integrations —
 * see each module's own header. This file adds a NEW, opt-in path for
 * callers that want a durable operation identity and resumable paid
 * preflight (Section 4):
 *
 *   POST /operations                                  free -- create
 *   GET  /operations/:operationId                      recovery-credential-gated -- status
 *   POST /x402/lifecycle/preflight-payment              paid, resumable, operation-bound
 *   POST /operations/:operationId/execution-bindings    recovery-credential-gated
 *   POST /operations/:operationId/finalize              capability-gated (same capability as legacy finalize)
 *
 * THE CORE SEAM (Section 4): x402's payment middleware settles payment
 * BEFORE any handler code runs (see discovery.ts's mountDiscovery — the
 * broad `paymentMiddleware` is mounted on `/x402/*` ahead of the specific
 * POST handler). A naive "Idempotency-Key after that point" cannot prevent
 * a second charge on retry, because by the time a handler could check an
 * idempotency key, the middleware has already tried to settle payment for
 * THIS request. The fix here is structural: a gate middleware, registered
 * on the SAME specific path and therefore run BEFORE the broad `/x402/*`
 * payment middleware (Hono runs `app.use` middleware in registration order
 * for matching paths — exactly the existing pattern already used for
 * /x402/preflight-payment's own pre-payment validator), claims the step
 * BEFORE payment is ever attempted:
 *
 *   - fresh claim            -> let payment middleware run, then complete
 *   - already completed      -> return the stored result, no next(), no payment
 *   - already paid (crashed  -> RESUME from the frozen candidate, no next(),
 *     before completing)        no payment, using the raw signing seam
 *   - claimed but not yet     -> 425, retry shortly (never a second payment
 *     paid (concurrent race)     attempt while the first might still land)
 */
import type { Context, Hono, Next } from 'hono'
import { createOperation, authenticateOperation, isValidOperationIdFormat } from './operation.js'
import {
  claimStep,
  getStepState,
  markPaid,
  recordCapability,
  completeStep,
  LifecycleStepConflictError,
  type LifecycleStepDependencies,
} from './lifecycleSteps.js'
import { updateCommerceOperationState, type CommerceOperationRecord } from './db.js'
import {
  parsePreflightInput,
  preflightPaymentFromInput,
  PreflightInputError,
  PreflightServiceError,
  type PreflightInput,
  type PreflightResult,
  type PreflightDependencies,
} from './preflight.js'
import { contentId } from './receipts.js'
import { mintFinalizationCapability, type FinalizationCapability } from './capability.js'

export const OPERATION_HEADER = 'x-ocd-operation-id'
export const RECOVERY_HEADER = 'x-ocd-recovery-credential'
export const PREFLIGHT_STEP_KEY = 'preflight'

interface FrozenPreflightInput {
  input: PreflightInput
  issuedAt: string
}

export interface LifecycleRouteDependencies {
  authenticateOperation?: typeof authenticateOperation
  step?: LifecycleStepDependencies
  updateCommerceOperationState?: typeof updateCommerceOperationState
  mintCapability?: typeof mintFinalizationCapability
  preflightDeps?: PreflightDependencies
}

/**
 * Shared by the fresh-payment path (called from the real POST handler,
 * after payment middleware succeeds and markPaid() has been recorded) and
 * the resume path (called from the gate when a step is already 'paid').
 * Reuses whatever capability was already minted/cached for this exact step
 * instead of minting a second one — the one deliberate use of the raw-token
 * cache documented in lifecycleSteps.ts.
 */
export async function runPreflightStepAndComplete(
  operationId: string,
  frozen: FrozenPreflightInput,
  deps: LifecycleRouteDependencies = {}
): Promise<PreflightResult> {
  const row = await getStepState(operationId, PREFLIGHT_STEP_KEY, deps.step)
  const result = await preflightPaymentFromInput(frozen.input, frozen.issuedAt, {
    ...deps.preflightDeps,
    mintCapability: async (preflightReceiptId, preflightReceiptDigest, publishCommerce): Promise<FinalizationCapability> => {
      if (row?.capabilityToken && row.capabilityExpiresAt) {
        return { token: row.capabilityToken, expiresAt: row.capabilityExpiresAt }
      }
      const mint = deps.mintCapability ?? mintFinalizationCapability
      const minted = await mint(preflightReceiptId, preflightReceiptDigest, publishCommerce)
      await recordCapability(operationId, PREFLIGHT_STEP_KEY, minted.token, minted.expiresAt, deps.step)
      return minted
    },
  })
  await completeStep(operationId, PREFLIGHT_STEP_KEY, result, deps.step)
  await (deps.updateCommerceOperationState ?? updateCommerceOperationState)(operationId, {
    preflightState: 'completed',
    preflightReceiptId: result.receipt.receipt.receipt_id,
  })
  return result
}

/**
 * The gate: auth + parse + claim, run BEFORE payment middleware. Returns a
 * Response directly (bypassing next()) whenever payment must NOT be
 * attempted this call — completed replay, in-flight resume, or an explicit
 * conflict/auth/input error. Calls next() only on a genuinely fresh claim.
 */
export function createLifecyclePreflightGate(deps: LifecycleRouteDependencies = {}) {
  return async function gate(c: Context, next: Next) {
    const operationId = c.req.header(OPERATION_HEADER)
    const credential = c.req.header(RECOVERY_HEADER)
    if (!operationId || !isValidOperationIdFormat(operationId)) {
      return c.json({ error: `missing or malformed ${OPERATION_HEADER} header -- create an operation via POST /operations first` }, 400)
    }
    const op = await (deps.authenticateOperation ?? authenticateOperation)(operationId, credential)
    if (!op) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.raw.clone().json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    let input: PreflightInput
    try {
      input = parsePreflightInput(rawBody)
    } catch (err) {
      return c.json({ error: err instanceof PreflightInputError ? err.message : 'invalid preflight input' }, 400)
    }

    const frozen: FrozenPreflightInput = { input, issuedAt: new Date().toISOString() }
    const inputDigest = contentId(input)

    let outcome
    try {
      outcome = await claimStep({ operationId, stepKey: PREFLIGHT_STEP_KEY, inputDigest, frozenInput: frozen }, deps.step)
    } catch (err) {
      if (err instanceof LifecycleStepConflictError) return c.json({ error: err.message }, 409)
      throw err
    }

    if (outcome.kind === 'completed') {
      return c.json(outcome.result, 200)
    }
    if (outcome.kind === 'in-progress') {
      if (outcome.row.status === 'paid') {
        // Payment for this exact step was already confirmed by a PRIOR
        // attempt that never completed -- resume from the frozen candidate.
        // Never call next(): payment middleware must not run a second time.
        try {
          const result = await runPreflightStepAndComplete(operationId, outcome.row.frozenInput as FrozenPreflightInput, deps)
          return c.json(result, 200)
        } catch (err: any) {
          return c.json({ error: err?.message || 'resuming this operation\'s preflight step failed' }, 502)
        }
      }
      // status === 'claimed': a concurrent request for the SAME step is
      // currently between claim and the 'paid' checkpoint. Never attempt
      // payment again while that might still land -- ask the caller to
      // retry shortly instead.
      c.header('Retry-After', '3')
      return c.json({ error: "this operation's preflight step is already being processed, retry shortly" }, 425)
    }

    // Fresh claim: stash the frozen candidate for the real handler and let
    // payment middleware run.
    c.set('ocdFrozenPreflightInput', frozen)
    await next()
  }
}

/** Runs only after payment middleware has succeeded for a genuinely fresh claim. */
export function createLifecyclePreflightHandler(deps: LifecycleRouteDependencies = {}) {
  return async function handler(c: Context) {
    const operationId = c.req.header(OPERATION_HEADER)!
    const frozen = c.get('ocdFrozenPreflightInput') as FrozenPreflightInput
    // Durable checkpoint recorded BEFORE any work that could crash: proves
    // payment was confirmed, so any later retry resumes rather than pays
    // again (Section 12: "signing retries should use the same frozen
    // signing candidate").
    await markPaid(operationId, PREFLIGHT_STEP_KEY, deps.step)
    try {
      const result = await runPreflightStepAndComplete(operationId, frozen, deps)
      return c.json(result, 200)
    } catch (err: any) {
      const status = err instanceof PreflightServiceError ? 502 : 500
      return c.json({ error: err?.message || 'preflight failed after payment was confirmed -- retry this exact request to resume, no new payment is required' }, status)
    }
  }
}

// ---------------------------------------------------------------------
// Operation lifecycle (create / read status)
// ---------------------------------------------------------------------

export async function operationsCreateHandler(c: Context) {
  const created = await createOperation()
  return c.json({ operation_id: created.operationId, recovery_credential: created.recoveryCredential }, 201)
}

export function createOperationsGetHandler(deps: LifecycleRouteDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const credential = c.req.header(RECOVERY_HEADER)
    const op: CommerceOperationRecord | null = await (deps.authenticateOperation ?? authenticateOperation)(operationId, credential)
    if (!op) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }
    return c.json({
      operation_id: op.operationId,
      preflight_state: op.preflightState,
      execution_state: op.executionState,
      observation_state: op.observationState,
      receipt_state: op.receiptState,
      preflight_receipt_id: op.preflightReceiptId,
    })
  }
}

export function mountLifecycle(app: Hono, deps: LifecycleRouteDependencies = {}): void {
  app.post('/operations', operationsCreateHandler)
  app.get('/operations/:operationId', createOperationsGetHandler(deps))

  // Registered BEFORE the broad `/x402/*` paymentMiddleware in
  // discovery.ts's mountDiscovery -- see that file, which mounts this
  // module's routes ahead of its own paymentMiddleware call.
  app.use('/x402/lifecycle/preflight-payment', createLifecyclePreflightGate(deps))
  app.post('/x402/lifecycle/preflight-payment', createLifecyclePreflightHandler(deps))
}
