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
 *                                                        (gate mounted by mountLifecycle(), BEFORE
 *                                                        mountDiscovery(); terminal handler mounted by
 *                                                        mountLifecyclePreflightHandler(), AFTER it —
 *                                                        see this file's header for why)
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
 * payment middleware, claims the step BEFORE payment is ever attempted:
 *
 *   - fresh claim            -> let payment middleware run, then complete
 *   - already completed      -> return the stored result, no next(), no payment
 *   - already paid (crashed  -> RESUME from the frozen candidate, no next(),
 *     before completing)        no payment, using the raw signing seam
 *   - claimed but not yet     -> let payment middleware run again (see the
 *     paid                       "UNPAID PROBES" incident below for why this
 *                                is NOT the same as a fresh claim skipping
 *                                the journal, and why it no longer 425s)
 *
 * REGISTRATION ORDER IS LOAD-BEARING (fixed post-D2.5A live re-qualification
 * -- see git history for the incident): Hono composes every handler whose
 * pattern matches a request in REGISTRATION order, not specificity order. A
 * gate + terminal handler registered back-to-back for the SAME exact path
 * (as this file originally did) run one after the other regardless of when
 * a broader `/x402/*` middleware is mounted elsewhere -- if that broader
 * middleware is registered LATER, it never gets inserted between them. That
 * shipped live: mountLifecycle() was called before mountDiscovery(), so the
 * terminal preflight handler answered (and signed a real receipt) before
 * mountDiscovery's payment middleware was ever in the chain -- the
 * "resumable, paid" preflight was actually free. The fix: mountLifecycle()
 * registers ONLY the gate (still before mountDiscovery()); the terminal
 * handler is a separate export, mountLifecyclePreflightHandler(), called
 * AFTER mountDiscovery() so payment middleware sits between them. See each
 * function's own doc comment and index.ts's call sites.
 *
 * UNPAID PROBES CAN PERMANENTLY CLAIM A STEP (second incident, same
 * milestone -- see git history): claimStep() durably claims on ANY request
 * that reaches this gate, whether or not that request ever carries a
 * payment authorization. There is no separate "resumable preflight, but
 * don't actually pay yet" endpoint -- the ONLY way to read the live
 * preflight price before paying (the SDK operator's checkLivePrices(), and
 * any well-behaved caller doing the same) is to send a real, unauthenticated
 * request to this exact route and read its 402 challenge. That request
 * claims the step, then payment middleware 402s it (no payment header), and
 * the request ends there -- but the claimed row never advances (there is no
 * timeout, and nothing else transitions 'claimed' -> 'paid'/'completed'
 * except a request that actually completes payment). Because the gate used
 * to treat ANY 'claimed'-but-unpaid row as "a payment might still be
 * concurrently landing" and refused (425) every further attempt with the
 * same input, a REAL payment attempt for that operation -- arriving any
 * time after nothing more than a single price probe -- could never
 * complete: it hit the 425 branch instead of ever reaching payment
 * middleware, and stayed stuck there forever (confirmed live: an operation
 * left claimed by one price probe never recovered on its own). Fixed by
 * letting a 'claimed'-but-unpaid step fall through to payment middleware
 * again on any subsequent request with the same input, exactly like a
 * fresh claim -- see the gate's own comment at the 'claimed' branch for the
 * reasoning on why this is safe.
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
      // status === 'claimed': FALL THROUGH to the fresh-claim path below --
      // see this file's header ("REGISTRATION ORDER IS LOAD-BEARING") for
      // the sibling incident this is the second half of. Confirmed live
      // (D2.5A): claimStep() durably claims on ANY request that reaches
      // this gate, including a plain unauthenticated PRICE PROBE (the
      // resumable route is the only way to read the live preflight fee
      // before paying -- see the SDK operator's checkLivePrices()). That
      // probe's request receives no payment header, so payment middleware
      // always 402s it and the request ends there -- but the step it
      // claimed stays 'claimed' forever (there is no timeout and nothing
      // else advances it). This module used to treat 'claimed' as proof a
      // payment might still be concurrently landing and refused (425) any
      // further attempt against the same input -- which meant a REAL
      // payment attempt for the SAME operation, arriving after nothing
      // more than an earlier price probe, could never complete: it hit
      // this exact 425 branch instead of ever reaching payment middleware.
      // A request that carries no payment authorization can never
      // complete a charge regardless (payment middleware 402s it every
      // time), so there is nothing to protect by blocking it -- and a
      // request that DOES carry one is precisely the resumed attempt this
      // step exists to allow. Genuinely concurrent duplicate real-payment
      // attempts (two overlapping requests each independently signed) are
      // no longer blocked at this layer; x402 payment middleware and the
      // facilitator's own per-authorization settlement are the actual
      // authority on whether a given payment is valid, and each concurrent
      // attempt still needs its own independently signed authorization --
      // this module was never a substitute for that. See
      // test/lifecycleRouteMounting.ts for the regression coverage.
    }

    // Fresh claim, or a resumed 'claimed'-but-unpaid step (see above):
    // stash the frozen candidate for the real handler and let payment
    // middleware run.
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

/**
 * Mounts /operations, GET /operations/:operationId, and the pre-payment GATE
 * for /x402/lifecycle/preflight-payment. Call this BEFORE mountDiscovery().
 *
 * The terminal POST handler for /x402/lifecycle/preflight-payment is
 * DELIBERATELY NOT registered here -- see mountLifecyclePreflightHandler()
 * below and its header comment for why. Registering it here was a confirmed
 * live defect (D2.5A): Hono composes handlers matching a path in
 * REGISTRATION order, so a terminal `app.post` registered here (before
 * mountDiscovery has mounted its broad `/x402/*` paymentMiddleware) responds
 * and ends the chain before that payment middleware is ever inserted --
 * the route evaluated and signed a real PREFLIGHT receipt for free, with no
 * 402 ever issued. See test/lifecycleRouteMounting.ts for the regression test.
 */
export function mountLifecycle(app: Hono, deps: LifecycleRouteDependencies = {}): void {
  app.post('/operations', operationsCreateHandler)
  app.get('/operations/:operationId', createOperationsGetHandler(deps))

  // Registered BEFORE the broad `/x402/*` paymentMiddleware in
  // discovery.ts's mountDiscovery -- so a recognized retry (already
  // completed, or paid-but-crashed) is served from this gate directly,
  // never re-attempting payment.
  app.use('/x402/lifecycle/preflight-payment', createLifecyclePreflightGate(deps))
}

/**
 * Mounts the TERMINAL handler for /x402/lifecycle/preflight-payment. Call
 * this AFTER mountDiscovery() -- so that call's `app.use('/x402/*',
 * paymentMiddleware(...))` is already registered ahead of this handler in
 * Hono's dispatch chain for this path. The resulting order for a fresh
 * request is: mountLifecycle's gate (claims the step) -> mountDiscovery's
 * paymentMiddleware (settles payment) -> this handler (evaluates and signs
 * the receipt) -- exactly the "gate -> payment -> handler" sequence this
 * file's header describes, and the same sequence discovery.ts itself uses
 * for the legacy /x402/preflight-payment route.
 */
export function mountLifecyclePreflightHandler(app: Hono, deps: LifecycleRouteDependencies = {}): void {
  app.post('/x402/lifecycle/preflight-payment', createLifecyclePreflightHandler(deps))
}
