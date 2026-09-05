/**
 * lifecycleSteps.ts — authenticated step idempotency (D2.4, Section 3).
 *
 * The invariant this module exists to provide:
 *
 *   same authenticated operation + same step key + same input digest
 *     = same result, or same pending operation
 *
 *   same operation + same step key + different digest
 *     = explicit conflict
 *
 * This is deliberately generic (any named step, not just "preflight") but
 * is used in D2.4 for exactly one step: 'preflight' (see lifecycleRoute.ts).
 * Finalization does NOT need this journal — the existing capability-
 * consumption transaction in db.ts (SELECT ... FOR UPDATE) already gives
 * finalize the equivalent guarantee for free, since finalize has no
 * payment-settlement-timing problem the way paid preflight does.
 *
 * RAW CAPABILITY TOKEN CACHING — a deliberate, narrow exception:
 * capability.ts's header says a finalization capability's raw token is
 * "returned to the caller exactly once ... and NEVER stored — losing the
 * raw token means losing the capability; that is intentional." D2.4's own
 * mandate ("a lost response after the OCD fee settles must NOT require
 * another OCD fee") is incompatible with that for the ONE case where the
 * lost response contained a capability the caller legitimately paid for
 * and never received. This module is the one place that relaxes it: the
 * raw token is cached in `lifecycle_steps.capability_token`, reachable only
 * by presenting the SAME operation's recovery credential (authenticateOperation,
 * checked by the caller before any function here is reached) for exactly as
 * long as the capability itself remains valid (its own TTL, unchanged from
 * capability.ts). This does not change finalization_capabilities itself —
 * that table still stores only a hash, exactly as before.
 *
 * Every function below takes an optional dependency-injection bag, same
 * convention as preflight.ts/finalizeRoute.ts, so tests can exercise the
 * claim/resume state machine with an in-memory fake store instead of a real
 * database.
 */
import {
  claimLifecycleStep,
  markLifecycleStepPaid,
  completeLifecycleStep,
  setLifecycleStepCapability,
  getLifecycleStep,
  type LifecycleStepRow,
} from './db.js'

export class LifecycleStepConflictError extends Error {
  constructor(operationId: string, stepKey: string) {
    super(
      `operation ${operationId} step "${stepKey}" was already used with different input -- ` +
        'refusing to reuse this step for a different request rather than silently proceeding'
    )
    this.name = 'LifecycleStepConflictError'
  }
}

export interface LifecycleStepDependencies {
  claimLifecycleStep?: typeof claimLifecycleStep
  markLifecycleStepPaid?: typeof markLifecycleStepPaid
  completeLifecycleStep?: typeof completeLifecycleStep
  setLifecycleStepCapability?: typeof setLifecycleStepCapability
  getLifecycleStep?: typeof getLifecycleStep
}

export type StepClaimOutcome<TInput = unknown> =
  | { kind: 'fresh'; frozenInput: TInput }
  | { kind: 'completed'; result: unknown; capabilityToken: string | null; capabilityExpiresAt: string | null }
  | { kind: 'in-progress'; row: LifecycleStepRow }

/**
 * Attempts to claim a step for fresh work. `inputDigest` must be computed
 * over the exact frozen input the caller is about to act on (see
 * commerceLifecycle.ts / receipts.ts's contentId, the same canonical
 * content-addressing used everywhere else in this codebase).
 */
export async function claimStep<TInput = unknown>(
  params: { operationId: string; stepKey: string; inputDigest: string; frozenInput: TInput },
  deps: LifecycleStepDependencies = {}
): Promise<StepClaimOutcome<TInput>> {
  const { claimed, row } = await (deps.claimLifecycleStep ?? claimLifecycleStep)(params)
  if (claimed) return { kind: 'fresh', frozenInput: params.frozenInput }
  if (row.inputDigest !== params.inputDigest) throw new LifecycleStepConflictError(params.operationId, params.stepKey)
  if (row.status === 'completed') {
    return { kind: 'completed', result: row.resultJson, capabilityToken: row.capabilityToken, capabilityExpiresAt: row.capabilityExpiresAt }
  }
  return { kind: 'in-progress', row }
}

/** Re-reads the current state of a step a caller already knows it owns (e.g. to decide whether to resume a 'paid'-but-not-'completed' step). */
export async function getStepState(
  operationId: string,
  stepKey: string,
  deps: LifecycleStepDependencies = {}
): Promise<LifecycleStepRow | null> {
  return (deps.getLifecycleStep ?? getLifecycleStep)(operationId, stepKey)
}

/** Durably records "payment/authorization for this step was confirmed" BEFORE any work that could crash — the checkpoint that makes resumption safe instead of a second charge. */
export async function markPaid(operationId: string, stepKey: string, deps: LifecycleStepDependencies = {}): Promise<void> {
  await (deps.markLifecycleStepPaid ?? markLifecycleStepPaid)(operationId, stepKey)
}

/** Records a freshly-minted one-time secret exactly once (a no-op if already set — see db.ts's `capability_token IS NULL` guard), so a resumed step reuses it instead of minting a second one. */
export async function recordCapability(
  operationId: string,
  stepKey: string,
  token: string,
  expiresAt: string,
  deps: LifecycleStepDependencies = {}
): Promise<void> {
  await (deps.setLifecycleStepCapability ?? setLifecycleStepCapability)(operationId, stepKey, token, expiresAt)
}

/** Marks a step complete with the exact result to replay on any future identical-input request. */
export async function completeStep(
  operationId: string,
  stepKey: string,
  result: unknown,
  deps: LifecycleStepDependencies = {}
): Promise<void> {
  await (deps.completeLifecycleStep ?? completeLifecycleStep)(operationId, stepKey, result)
}
