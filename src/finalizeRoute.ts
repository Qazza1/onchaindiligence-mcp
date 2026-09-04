/**
 * finalizeRoute.ts — POST /receipts/finalize (D2.2).
 *
 * FREE, but capability-protected. Not a generic receipt-creation endpoint:
 * it accepts only the execution evidence needed to finalize the ONE
 * PREFLIGHT lifecycle bound to the supplied capability, and the service
 * constructs the Commerce Receipt itself — the caller never supplies
 * amount/recipient/asset/sender/network as authoritative facts (those come
 * from the bound preflight + independent chain observation only).
 *
 * Ordering matters here for safety: capability CONSUMPTION happens only
 * after everything that can fail — input validation, chain observation,
 * receipt signing, and independent VALID re-verification — has already
 * succeeded (see db.ts's consumeCapabilityAndPublish, called last). A crash
 * or RPC failure anywhere before that point leaves the capability untouched
 * and safe to retry. A retry with the identical transaction hash after a
 * prior success returns the same existing Commerce Receipt idempotently; a
 * retry with a DIFFERENT transaction hash after a prior success is rejected.
 */
import type { Context, Hono } from 'hono'
import {
  peekCapability,
  getReceiptForFinalization,
  consumeCapabilityAndPublish,
  hashCapabilityToken,
} from './db.js'
import { extractBearerCapability } from './capability.js'
import { observeTransaction, isValidTransactionHash, UnsupportedSettlementScopeError, BASE_CAIP2 } from './settlement.js'
import { buildCommerceReceiptCore, type FinalizationExecutionInput } from './commerceReceipt.js'
import { attest } from './attest.js'
import {
  buildReceiptCore,
  finalizeReceiptCore,
  fetchAttestationKeyRegistry,
  verifyReceiptEnvelope,
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  type Receipt,
  type PublicActionReceiptEnvelope,
} from './receipts.js'

export class FinalizationAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalizationAuthError'
  }
}
export class FinalizationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalizationConflictError'
  }
}
export class FinalizationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalizationInputError'
  }
}
export class FinalizationServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalizationServiceError'
  }
}

/**
 * D2.2B2: thrown when chain observation has not yet produced a DEFINITIVE
 * result — transaction not yet found, the RPC was unreachable, or the
 * transaction succeeded but has not yet reached the required confirmation
 * depth. None of these are a reason to build a receipt or consume the
 * finalization capability: they are the caller's cue to retry the exact same
 * request later, once observation is definitive one way or the other
 * (reverted, or successful + sufficiently confirmed). See
 * src/settlement.ts's ChainInspectionState and finalizePayment() below,
 * where this is thrown BEFORE buildCommerceReceiptCore/signing/consumption —
 * so the capability row is provably untouched on every path that reaches
 * this error.
 */
export type FinalizationPendingReason = 'transaction-not-found' | 'rpc-unavailable' | 'insufficient-confirmations'

export class FinalizationPendingError extends Error {
  readonly reason: FinalizationPendingReason
  readonly httpStatus: 425 | 503
  readonly retryAfterSeconds: number
  constructor(reason: FinalizationPendingReason, message: string, httpStatus: 425 | 503, retryAfterSeconds = 10) {
    super(message)
    this.name = 'FinalizationPendingError'
    this.reason = reason
    this.httpStatus = httpStatus
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const EXECUTION_PROVIDERS = new Set(['x402', 'paybox', 'wallet', 'other'])
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/
// Fields that describe settlement facts. These MUST come only from the bound
// preflight + independent chain observation, never from the caller — reject
// outright rather than silently ignoring, so a caller can never wonder
// whether a supplied value was quietly used.
const FORBIDDEN_FIELDS = ['amount', 'recipient', 'asset', 'sender', 'network']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFinalizationExecutionInput(raw: unknown): FinalizationExecutionInput {
  if (!isPlainObject(raw)) throw new FinalizationInputError('body must be a JSON object')
  for (const field of FORBIDDEN_FIELDS) {
    if (raw[field] !== undefined) {
      throw new FinalizationInputError(
        `${field} must not be supplied — settlement facts come only from the bound preflight receipt and independent chain observation, never from the caller`
      )
    }
  }
  if (!isValidTransactionHash(raw.transaction_hash)) {
    throw new FinalizationInputError('transaction_hash must be a 0x-prefixed, 64-hex-character transaction hash')
  }
  if (typeof raw.execution_provider !== 'string' || !EXECUTION_PROVIDERS.has(raw.execution_provider)) {
    throw new FinalizationInputError('execution_provider must be one of: x402, paybox, wallet, other')
  }
  let providerReference: string | null = null
  if (raw.provider_reference !== undefined && raw.provider_reference !== null) {
    if (typeof raw.provider_reference !== 'string' || raw.provider_reference.length === 0 || raw.provider_reference.length > 512) {
      throw new FinalizationInputError('provider_reference must be a non-empty string (max 512 characters), or null')
    }
    providerReference = raw.provider_reference
  }
  let resultDigest: string | null = null
  if (raw.result_digest !== undefined && raw.result_digest !== null) {
    if (typeof raw.result_digest !== 'string' || !DIGEST_PATTERN.test(raw.result_digest)) {
      throw new FinalizationInputError('result_digest must be a "sha256:<base64url>" content digest, or null')
    }
    resultDigest = raw.result_digest
  }
  return {
    transaction_hash: raw.transaction_hash,
    execution_provider: raw.execution_provider as FinalizationExecutionInput['execution_provider'],
    provider_reference: providerReference,
    result_digest: resultDigest,
  }
}

export interface FinalizeDependencies {
  peekCapability?: typeof peekCapability
  getReceiptForFinalization?: typeof getReceiptForFinalization
  observeTransaction?: typeof observeTransaction
  signReceipt?: (receipt: Receipt) => Promise<PublicActionReceiptEnvelope['proof']>
  fetchKeyRegistry?: () => Promise<Parameters<typeof verifyReceiptEnvelope>[1]>
  consumeCapabilityAndPublish?: typeof consumeCapabilityAndPublish
}

export interface FinalizeResult {
  envelope: PublicActionReceiptEnvelope
  idempotentReplay: boolean
}

async function loadExistingCommerceReceipt(
  deps: FinalizeDependencies,
  commerceReceiptId: string | null
): Promise<PublicActionReceiptEnvelope> {
  if (!commerceReceiptId) {
    throw new FinalizationServiceError('capability was marked consumed but no Commerce Receipt id was recorded')
  }
  const stored = await (deps.getReceiptForFinalization ?? getReceiptForFinalization)(commerceReceiptId)
  if (!stored) {
    throw new FinalizationServiceError('capability was marked consumed but its Commerce Receipt could not be located')
  }
  return stored.envelope
}

/**
 * The service function both the HTTP route and (if ever needed) a future
 * transport adapt to. `rawAuthorizationHeader` is the literal
 * `Authorization` header value — never logged by this function or its
 * callers.
 */
export async function finalizePayment(
  rawAuthorizationHeader: string | null | undefined,
  rawBody: unknown,
  deps: FinalizeDependencies = {}
): Promise<FinalizeResult> {
  const token = extractBearerCapability(rawAuthorizationHeader)
  if (!token) {
    throw new FinalizationAuthError('missing or malformed Authorization header — expected "Bearer <finalization capability>"')
  }
  const execution = parseFinalizationExecutionInput(rawBody)
  const capabilityHash = hashCapabilityToken(token)

  // Fast, non-locking pre-check: fail obviously-bad requests before any
  // RPC/signing work. The atomic consume-and-publish step at the end is the
  // actual authority; this is purely an optimization.
  const precheck = await (deps.peekCapability ?? peekCapability)(capabilityHash)
  if (!precheck) throw new FinalizationAuthError('invalid finalization capability')
  if (precheck.usedAt) {
    if (precheck.consumedTransactionHash === execution.transaction_hash) {
      return { envelope: await loadExistingCommerceReceipt(deps, precheck.commerceReceiptId), idempotentReplay: true }
    }
    throw new FinalizationConflictError('this finalization capability has already been consumed for a different transaction')
  }
  if (new Date(precheck.expiresAt).getTime() <= Date.now()) {
    throw new FinalizationAuthError('this finalization capability has expired')
  }

  const preflightStored = await (deps.getReceiptForFinalization ?? getReceiptForFinalization)(precheck.preflightReceiptId)
  if (!preflightStored) throw new FinalizationServiceError('the bound preflight receipt could not be located')
  const preflightReceipt = preflightStored.envelope.receipt
  if (preflightReceipt.receipt_digest !== precheck.preflightReceiptDigest) {
    throw new FinalizationServiceError('bound preflight receipt digest mismatch — refusing to finalize')
  }
  if (preflightReceipt.receipt_type !== 'PREFLIGHT') {
    throw new FinalizationServiceError('bound receipt is not a PREFLIGHT receipt')
  }

  const registry = await (deps.fetchKeyRegistry ?? fetchAttestationKeyRegistry)()
  const preflightVerification = verifyReceiptEnvelope(preflightStored.envelope, registry)
  if (preflightVerification.state !== 'VALID') {
    throw new FinalizationServiceError(
      `bound preflight receipt does not independently verify VALID (${preflightVerification.code}: ${preflightVerification.message})`
    )
  }

  let observation
  try {
    observation = await (deps.observeTransaction ?? observeTransaction)(
      execution.transaction_hash,
      preflightReceipt.action.network ?? BASE_CAIP2,
      preflightReceipt.action.asset ?? ''
    )
  } catch (err) {
    if (err instanceof UnsupportedSettlementScopeError) throw new FinalizationInputError(err.message)
    throw err
  }

  // D2.2B2: only a DEFINITIVE observation may proceed past this point --
  // reverted (definitively failed), or successful with the required
  // confirmation depth reached. Anything else is retryable: no receipt is
  // built, nothing is signed, and consumeCapabilityAndPublish (below) is
  // never reached, so the capability stays unconsumed for a later retry of
  // this exact same request.
  if (observation.state === 'not-found') {
    throw new FinalizationPendingError(
      'transaction-not-found',
      'The supplied transaction was not yet found on Base mainnet. This is retryable: the finalization capability has not been consumed.',
      425
    )
  }
  if (observation.state === 'rpc-unavailable') {
    throw new FinalizationPendingError(
      'rpc-unavailable',
      `The Base RPC endpoint could not be reached: ${observation.rpcError ?? 'unknown error'}. This is retryable: the finalization capability has not been consumed.`,
      503
    )
  }
  if (observation.state === 'success' && !observation.sufficientlyConfirmed) {
    throw new FinalizationPendingError(
      'insufficient-confirmations',
      'The transaction was observed but has not yet reached the required confirmation depth. This is retryable: the finalization capability has not been consumed.',
      425
    )
  }

  const built = buildCommerceReceiptCore(preflightReceipt, execution, observation)
  const core = buildReceiptCore({
    receipt_type: 'COMMERCE',
    issued_at: new Date().toISOString(),
    action: built.action,
    decision: preflightReceipt.decision, // copied verbatim -- never re-evaluated here
    execution: built.execution,
    settlement: built.settlement,
    checks: built.checks,
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: preflightReceipt.receipt_id },
    limitations: built.limitations,
  })
  const receipt = finalizeReceiptCore(core)

  const proof = deps.signReceipt
    ? await deps.signReceipt(receipt)
    : ((await attest(receipt, { purpose: PUBLIC_ACTION_RECEIPT_PURPOSE })).attestation as PublicActionReceiptEnvelope['proof'])
  const envelope: PublicActionReceiptEnvelope = { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }

  const verification = verifyReceiptEnvelope(envelope, registry)
  if (verification.state !== 'VALID') {
    throw new FinalizationServiceError(
      `generated Commerce Receipt did not verify VALID (${verification.code}: ${verification.message}) -- not published, capability left unconsumed for retry`
    )
  }

  const outcome = await (deps.consumeCapabilityAndPublish ?? consumeCapabilityAndPublish)({
    capabilityHash,
    transactionHash: execution.transaction_hash,
    commerceEnvelope: envelope,
    isPublic: precheck.publishCommerce,
  })

  switch (outcome.kind) {
    case 'consumed':
      return { envelope, idempotentReplay: false }
    case 'replay':
      return { envelope: await loadExistingCommerceReceipt(deps, outcome.commerceReceiptId), idempotentReplay: true }
    case 'consumed-different-tx':
      throw new FinalizationConflictError('this finalization capability has already been consumed for a different transaction')
    case 'expired':
      throw new FinalizationAuthError('this finalization capability has expired')
    case 'not-found':
      throw new FinalizationAuthError('invalid finalization capability')
  }
}

// ---------------------------------------------------------------------
// HTTP adapter
// ---------------------------------------------------------------------

/**
 * Minimal, best-effort, per-instance rate limit keyed by capability hash —
 * NOT a distributed limiter (this is a stateless serverless deployment with
 * no shared in-memory store), but it does bound retry storms within one warm
 * instance without interfering with legitimate retry semantics (a
 * successful finalize is never throttled on replay; only rapid repeated
 * attempts are). Capability hashes are single-use secrets, not enumerable,
 * so this is defense in depth, not the primary access control.
 */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_ATTEMPTS = 20
const attemptLog = new Map<string, number[]>()

function rateLimited(capabilityHash: string): boolean {
  const now = Date.now()
  const attempts = (attemptLog.get(capabilityHash) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  attempts.push(now)
  attemptLog.set(capabilityHash, attempts)
  if (attemptLog.size > 10_000) attemptLog.clear() // bound memory in a long-lived warm instance
  return attempts.length > RATE_LIMIT_MAX_ATTEMPTS
}

/**
 * Factory rather than a bare handler, so tests can inject the same
 * FinalizeDependencies seam finalizePayment() itself accepts and exercise
 * the HTTP status-code mapping (401/400/409/429/200) fully offline.
 * `mountFinalize` calls this with no arguments, which is exactly the real
 * production handler.
 */
export function createFinalizePostHandler(deps: FinalizeDependencies = {}) {
  return async function finalizePostHandler(c: Context) {
    const authHeader = c.req.header('authorization')
    const token = extractBearerCapability(authHeader)
    if (token && rateLimited(hashCapabilityToken(token))) {
      c.header('Retry-After', '30')
      return c.json({ error: 'too many finalization attempts for this capability, please slow down' }, 429)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    try {
      const result = await finalizePayment(authHeader, body, deps)
      return c.json(result.envelope, 200)
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
  }
}

/** The real production handler — no injected dependencies. */
export const finalizePostHandler = createFinalizePostHandler()

export function mountFinalize(app: Hono): void {
  app.post('/receipts/finalize', finalizePostHandler)
}
