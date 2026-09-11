/**
 * D3.4C1 provider evidence.
 *
 * This module records a normalized, content-addressed claim made by an
 * execution provider. It deliberately has no RPC client and never calls a
 * facilitator: supplied response material is a claim, not an OCD observation.
 * Only digests of raw response/reference material are retained.
 */
import { getExecutionBinding } from './executionBinding.js'
import { createProviderEvidence, type ProviderEvidenceRecord } from './db.js'
import { contentId } from './receipts.js'
import { isValidTransactionHash } from './settlement.js'

export const PROVIDER_EVIDENCE_SOURCE = 'CALLER_REPORTED_PROVIDER_RESPONSE' as const
export class ProviderEvidenceInputError extends Error {}

export interface ProviderEvidenceInput {
  provider: string
  providerVersion: string | null
  providerExecutionId: string | null
  correlationReference: string | null
  x402Version: string | null
  claimedState: 'SUCCEEDED' | 'FAILED'
  transactionHash: string | null
  network: string | null
  payer: string | null
  amountAtomic: string | null
  asset: string | null
  recipient: string | null
  failureCode: string | null
  failureDigest: string | null
  rawReferenceDigest: string | null
  executionRequestId: string | null
  providerEventId: string | null
  providerTimestamp: string | null
}

/**
 * PayBox's public request status is deliberately normalized separately from
 * the standard x402 facilitator response.  The two systems do not make the
 * same assertion: a PayBox request is a provider-side execution claim, not
 * an x402 settlement response and never an OCD chain observation.
 *
 * Only PayBox terminal states are accepted.  Pending approval/signature is
 * intentionally omitted rather than being recast as a failure; the existing
 * execution binding already represents a submitted-but-unresolved attempt.
 */
function parsePayBoxProviderEvidenceInput(body: Record<string, unknown>, rawClaim: Record<string, unknown>): ProviderEvidenceInput {
  const requestId = optionalString(rawClaim.request_id, 'paybox_response.request_id', 200)
  if (!requestId) throw new ProviderEvidenceInputError('paybox_response.request_id is required')
  const status = optionalString(rawClaim.status, 'paybox_response.status', 64)
  if (status !== 'success' && status !== 'denied' && status !== 'error') {
    throw new ProviderEvidenceInputError('paybox_response.status must be one of: success, denied, error (pending states are not terminal provider evidence)')
  }
  const payment = object(rawClaim.payment) ? rawClaim.payment : null
  const resourceResponse = object(rawClaim.response) ? rawClaim.response : null
  const rawReferenceDigest = optionalDigest(body.raw_reference_digest, 'raw_reference_digest') ?? contentId({
    provider: 'paybox', request_id: requestId, status,
    output_id: optionalString(rawClaim.output_id, 'paybox_response.output_id', 200),
    audit_id: optionalString(rawClaim.audit_id, 'paybox_response.audit_id', 200),
    payment: payment ? {
      gateway: payment.gateway === true, status: optionalString(payment.status, 'paybox_response.payment.status', 64),
      ok: payment.ok === true, network: optionalString(payment.network, 'paybox_response.payment.network', 160),
      scheme: optionalString(payment.scheme, 'paybox_response.payment.scheme', 64),
    } : null,
    response: resourceResponse ? {
      status: typeof resourceResponse.status === 'number' && Number.isSafeInteger(resourceResponse.status) ? resourceResponse.status : null,
      ok: resourceResponse.ok === true,
    } : null,
  })
  const failureDigest = optionalDigest(body.error_digest, 'error_digest')
  const failureCode = status === 'success' ? null : status === 'denied' ? 'PAYBOX_DENIED' : 'PAYBOX_ERROR'
  const timestamp = optionalString(body.provider_timestamp, 'provider_timestamp', 64)
  if (timestamp !== null && Number.isNaN(Date.parse(timestamp))) throw new ProviderEvidenceInputError('provider_timestamp must be an ISO timestamp, or null')

  return {
    provider: 'paybox',
    providerVersion: optionalString(body.provider_version, 'provider_version', 120),
    providerExecutionId: requestId,
    correlationReference: `paybox:${requestId}`,
    x402Version: null,
    claimedState: status === 'success' ? 'SUCCEEDED' : 'FAILED',
    transactionHash: null,
    // A gateway response can report the payment network.  Amount, asset,
    // payer and recipient are intentionally left null unless a future
    // PayBox public response actually supplies them; frozen OCD action data
    // is not rewritten as a provider assertion.
    network: payment ? optionalString(payment.network, 'paybox_response.payment.network', 160) : null,
    payer: null,
    amountAtomic: null,
    asset: null,
    recipient: null,
    failureCode,
    failureDigest,
    rawReferenceDigest,
    executionRequestId: optionalString(body.execution_request_id, 'execution_request_id'),
    // output_id is the documented non-secret, provider-generated result
    // identity. audit_id remains only in the digest, avoiding a new schema
    // field with ambiguous semantics.
    providerEventId: optionalString(rawClaim.output_id, 'paybox_response.output_id', 200),
    providerTimestamp: timestamp,
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, name: string, max = 512): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ProviderEvidenceInputError(`${name} must be a non-empty string (max ${max} characters), or null`)
  return value
}

function optionalDigest(value: unknown, name: string): string | null {
  const result = optionalString(value, name, 80)
  if (result !== null && !/^sha256:[0-9a-fA-F]{64}$/.test(result) && !/^sha256:[A-Za-z0-9_-]{43}$/.test(result)) {
    throw new ProviderEvidenceInputError(`${name} must be a sha256 digest, or null`)
  }
  return result
}

function optionalAddress(value: unknown, name: string): string | null {
  const result = optionalString(value, name, 42)
  if (result !== null && !/^0x[0-9a-fA-F]{40}$/.test(result)) throw new ProviderEvidenceInputError(`${name} must be a 0x-prefixed EVM address, or null`)
  return result
}

/**
 * Standard x402 settle response adapter. Both camelCase and snake_case are
 * accepted only for common interoperability; stored output is normalized.
 * `raw_response` is intentionally not accepted. Its digest/reference may be
 * supplied instead, so credentials or payment payloads are never persisted.
 */
export function parseProviderEvidenceInput(body: unknown): ProviderEvidenceInput {
  if (!object(body)) throw new ProviderEvidenceInputError('body must be a JSON object')
  if (body.paybox_response !== undefined) {
    if (!object(body.paybox_response)) throw new ProviderEvidenceInputError('paybox_response must be a JSON object')
    return parsePayBoxProviderEvidenceInput(body, body.paybox_response)
  }
  const provider = optionalString(body.provider ?? 'x402-facilitator', 'provider', 120)!
  const rawClaim = body.x402_settle_response ?? body.claim ?? body
  if (!object(rawClaim)) throw new ProviderEvidenceInputError('x402_settle_response must be a JSON object')

  const success = rawClaim.success
  if (typeof success !== 'boolean') throw new ProviderEvidenceInputError('x402_settle_response.success must be a boolean')
  const transactionHash = optionalString(rawClaim.transaction ?? rawClaim.transaction_hash, 'x402_settle_response.transaction', 66)
  if (transactionHash !== null && !isValidTransactionHash(transactionHash)) throw new ProviderEvidenceInputError('x402_settle_response.transaction must be a 0x-prefixed 32-byte transaction hash, or null')
  const timestamp = optionalString(body.provider_timestamp ?? rawClaim.timestamp, 'provider_timestamp', 64)
  if (timestamp !== null && Number.isNaN(Date.parse(timestamp))) throw new ProviderEvidenceInputError('provider_timestamp must be an ISO timestamp, or null')

  const error = rawClaim.error
  const errorCode = typeof error === 'string' ? optionalString(error, 'x402_settle_response.error', 256) : object(error) ? optionalString(error.code, 'x402_settle_response.error.code', 128) : null
  const errorDigest = optionalDigest(body.error_digest ?? (object(error) ? error.digest : null), 'error_digest')
  if (!success && !errorCode && !errorDigest) throw new ProviderEvidenceInputError('a failed provider claim requires error information or error_digest')

  return {
    provider,
    providerVersion: optionalString(body.provider_version, 'provider_version', 120),
    providerExecutionId: optionalString(body.provider_execution_id ?? rawClaim.execution_id, 'provider_execution_id'),
    correlationReference: optionalString(body.correlation_reference ?? rawClaim.payment_id ?? rawClaim.request_id, 'correlation_reference'),
    x402Version: (() => {
      const value = rawClaim.x402Version ?? rawClaim.x402_version
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
      return optionalString(value, 'x402_settle_response.x402Version', 32)
    })(),
    claimedState: success ? 'SUCCEEDED' : 'FAILED',
    transactionHash,
    network: optionalString(rawClaim.network, 'x402_settle_response.network', 160),
    payer: optionalAddress(rawClaim.payer, 'x402_settle_response.payer'),
    amountAtomic: optionalString(rawClaim.amount_atomic ?? rawClaim.amount, 'x402_settle_response.amount', 100),
    asset: optionalString(rawClaim.asset, 'x402_settle_response.asset', 160),
    recipient: optionalAddress(rawClaim.recipient, 'x402_settle_response.recipient'),
    failureCode: errorCode,
    failureDigest: errorDigest,
    rawReferenceDigest: optionalDigest(body.raw_reference_digest ?? rawClaim.reference_digest, 'raw_reference_digest'),
    executionRequestId: optionalString(body.execution_request_id, 'execution_request_id'),
    providerEventId: optionalString(body.provider_event_id ?? rawClaim.event_id, 'provider_event_id'),
    providerTimestamp: timestamp,
  }
}

function evidenceId(operationId: string, input: ProviderEvidenceInput): string {
  return contentId({ operationId, ...input, sourceAuthentication: PROVIDER_EVIDENCE_SOURCE })
}

export interface RecordProviderEvidenceDependencies {
  getExecutionBinding?: typeof getExecutionBinding
  createProviderEvidence?: typeof createProviderEvidence
}

/**
 * The only hard correlation check is an explicitly supplied execution binding
 * belonging to this operation. All other provider identifiers are retained as
 * claims for later reconciliation; none can alter observation/binding state.
 */
export async function recordProviderEvidence(operationId: string, input: ProviderEvidenceInput, deps: RecordProviderEvidenceDependencies = {}): Promise<{ created: boolean; evidence: ProviderEvidenceRecord }> {
  const getBinding = deps.getExecutionBinding ?? getExecutionBinding
  if (input.executionRequestId) {
    const binding = await getBinding(input.executionRequestId)
    if (!binding || binding.operationId !== operationId) throw new ProviderEvidenceInputError('execution_request_id does not belong to this operation')
    if (input.provider === 'paybox') {
      if (binding.executorIdentity !== 'paybox-x402-base-usdc') throw new ProviderEvidenceInputError('PayBox provider evidence requires a PayBox execution binding')
      if (binding.providerReference !== input.correlationReference) {
        throw new ProviderEvidenceInputError('PayBox request_id does not match the durable execution binding provider_reference')
      }
    }
  }
  const create = deps.createProviderEvidence ?? createProviderEvidence
  return create({ evidenceId: evidenceId(operationId, input), operationId, ...input, sourceAuthentication: PROVIDER_EVIDENCE_SOURCE })
}
