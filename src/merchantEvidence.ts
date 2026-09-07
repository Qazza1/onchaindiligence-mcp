/**
 * merchantEvidence.ts — D2.9A merchant/response evidence (Sections 1-4).
 *
 * "The payment happened. What did the merchant actually return?" OCD has
 * strong, independently-observed PAYMENT evidence (D2.4) but has never
 * claimed to independently observe merchant SERVICE DELIVERY -- the
 * Commerce receipt's own `service-delivery-verification` check has always
 * been NOT_CHECKED (commerceReceipt.ts), and stays that way. This module
 * lets a caller RECORD what the merchant returned, honestly labeled as
 * CALLER_REPORTED -- never upgraded to an independent OCD claim, because
 * nothing here independently re-fetches or re-verifies the merchant.
 *
 * The raw response body is NEVER persisted (Section 2) -- only a SHA-256
 * digest, byte length, content type, HTTP status, and a small allowlist of
 * response headers. Never payment signatures, authorization headers,
 * cookies, API keys, x402 payloads, or PayBox credentials -- none of those
 * are even accepted as input fields here.
 */
import { getExecutionBinding } from './executionBinding.js'
import { createMerchantEvidence, type MerchantEvidenceRecord } from './db.js'
import { contentId } from './receipts.js'

/** Deliberately closed to exactly one value for this first slice -- see this file's header and db/schema.sql's CHECK constraint. Nothing here ever lets a caller choose or upgrade it. */
export const MERCHANT_EVIDENCE_SOURCE = 'CALLER_REPORTED' as const

/** Small, explicit allowlist (Section 2) -- anything else submitted is silently dropped, never stored. */
export const ALLOWED_RESPONSE_HEADERS = ['etag', 'content-length', 'x-request-id'] as const

export class MerchantEvidenceInputError extends Error {}

export interface MerchantEvidenceInput {
  resourceUrl: string
  httpStatus: number
  contentType: string | null
  responseBodyDigest: string
  responseBytes: number | null
  executionRequestId: string | null
  providerReference: string | null
  transactionHash: string | null
  responseHeaders: Record<string, string> | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keeps ONLY the allowlisted header names, case-insensitively, dropping everything else -- including anything shaped like a secret, since it was never on the allowlist to begin with. */
export function sanitizeResponseHeaders(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null
  const lowered = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]))
  const out: Record<string, string> = {}
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const v = lowered.get(name)
    if (typeof v === 'string' && v.length > 0 && v.length <= 500) out[name] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Structural validation only -- never rejects merely because an OPTIONAL
 * correlation field (execution_request_id/provider_reference/
 * transaction_hash) is absent or doesn't (yet) match known state; that is
 * evaluated as correlation strength / findings, not a submission error
 * (Section 3). A malformed value for a field that IS supplied is still
 * rejected -- "optional" means "may be omitted", not "may be garbage".
 */
export function parseMerchantEvidenceInput(body: unknown): MerchantEvidenceInput {
  if (!isPlainObject(body)) throw new MerchantEvidenceInputError('body must be a JSON object')

  const resourceUrl = body.resource_url
  if (typeof resourceUrl !== 'string' || resourceUrl.length === 0) throw new MerchantEvidenceInputError('resource_url is required')
  try {
    new URL(resourceUrl)
  } catch {
    throw new MerchantEvidenceInputError('resource_url must be a valid absolute URL')
  }

  const httpStatus = body.http_status
  if (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new MerchantEvidenceInputError('http_status must be an integer between 100 and 599')
  }

  const contentType = body.content_type
  if (contentType !== undefined && contentType !== null && typeof contentType !== 'string') {
    throw new MerchantEvidenceInputError('content_type must be a string, or null')
  }

  const responseBodyDigest = body.response_body_digest
  if (typeof responseBodyDigest !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/.test(responseBodyDigest)) {
    throw new MerchantEvidenceInputError('response_body_digest must be "sha256:<64 hex chars>"')
  }

  const responseBytes = body.response_bytes
  if (responseBytes !== undefined && responseBytes !== null && (typeof responseBytes !== 'number' || !Number.isInteger(responseBytes) || responseBytes < 0)) {
    throw new MerchantEvidenceInputError('response_bytes must be a non-negative integer, or null')
  }

  const executionRequestId = body.execution_request_id
  if (executionRequestId !== undefined && executionRequestId !== null && typeof executionRequestId !== 'string') {
    throw new MerchantEvidenceInputError('execution_request_id must be a string, or null')
  }

  const providerReference = body.provider_reference
  if (providerReference !== undefined && providerReference !== null && typeof providerReference !== 'string') {
    throw new MerchantEvidenceInputError('provider_reference must be a string, or null')
  }

  const transactionHash = body.transaction_hash
  if (transactionHash !== undefined && transactionHash !== null && (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash))) {
    throw new MerchantEvidenceInputError('transaction_hash must be a 0x-prefixed 32-byte hex string, or null')
  }

  return {
    resourceUrl,
    httpStatus,
    contentType: contentType ?? null,
    responseBodyDigest,
    responseBytes: responseBytes ?? null,
    executionRequestId: executionRequestId ?? null,
    providerReference: providerReference ?? null,
    transactionHash: transactionHash ?? null,
    responseHeaders: sanitizeResponseHeaders(body.response_headers),
  }
}

/** Content-derived, same convention as commerce_observations.observation_id -- a byte-identical retried submission always computes the SAME id, making the insert idempotent without a separate dedupe lookup. */
function computeEvidenceId(operationId: string, input: MerchantEvidenceInput): string {
  return contentId({
    operationId,
    resourceUrl: input.resourceUrl,
    httpStatus: input.httpStatus,
    contentType: input.contentType,
    responseBodyDigest: input.responseBodyDigest,
    responseBytes: input.responseBytes,
    executionRequestId: input.executionRequestId,
    providerReference: input.providerReference,
    transactionHash: input.transactionHash,
    // D2.9A correction: must be part of the digest, or two records that
    // differ ONLY in their allowlisted response headers (e.g. a genuinely
    // different ETag) would collapse onto the same evidence_id and the
    // second submission would be silently treated as a replay of the
    // first, rather than the append-only new record it actually is. Uses
    // the ALREADY-SANITIZED value (input.responseHeaders has already been
    // through sanitizeResponseHeaders() by the time this runs) -- never
    // raw/arbitrary headers, and contentId()'s own canonicalizer sorts
    // object keys, so header order never affects the digest.
    responseHeaders: input.responseHeaders,
  })
}

export interface RecordMerchantEvidenceDependencies {
  getExecutionBinding?: typeof getExecutionBinding
  createMerchantEvidence?: typeof createMerchantEvidence
}

/**
 * The ONE hard reference check (Section 3): a supplied execution_request_id
 * must actually belong to this operation, or the request is rejected --
 * this is a genuine input error, not "correlation unavailable" (a caller
 * that doesn't know the execution_request_id should simply omit it).
 * provider_reference/transaction_hash are recorded as submitted either
 * way; whether they actually correlate with known state is evaluated by
 * the investigation/findings layer (Sections 5-6), never enforced here.
 */
export async function recordMerchantEvidence(
  operationId: string,
  input: MerchantEvidenceInput,
  deps: RecordMerchantEvidenceDependencies = {}
): Promise<{ created: boolean; evidence: MerchantEvidenceRecord }> {
  const doGetBinding = deps.getExecutionBinding ?? getExecutionBinding
  const doCreate = deps.createMerchantEvidence ?? createMerchantEvidence

  if (input.executionRequestId) {
    const binding = await doGetBinding(input.executionRequestId)
    if (!binding || binding.operationId !== operationId) {
      throw new MerchantEvidenceInputError('execution_request_id does not belong to this operation')
    }
  }

  const evidenceId = computeEvidenceId(operationId, input)
  return doCreate({
    evidenceId,
    operationId,
    resourceUrl: input.resourceUrl,
    httpStatus: input.httpStatus,
    contentType: input.contentType,
    responseBodyDigest: input.responseBodyDigest,
    responseBytes: input.responseBytes,
    executionRequestId: input.executionRequestId,
    providerReference: input.providerReference,
    transactionHash: input.transactionHash,
    responseHeaders: input.responseHeaders,
  })
}
