/**
 * merchantEvidenceRoute.ts — D2.9A HTTP surface (Section 3).
 *
 *   POST /operations/:operationId/merchant-evidence   recovery-credential-gated
 *
 * Same auth mechanism as the existing D2.4 operation routes
 * (lifecycleFinalizeRoute.ts) -- the operation's own recovery_credential,
 * not an account API key. Entirely additive; cannot mutate any D2.4/D2.6
 * lifecycle state.
 */
import type { Context, Hono } from 'hono'
import { authenticateOperation } from './operation.js'
import { parseMerchantEvidenceInput, recordMerchantEvidence, MerchantEvidenceInputError, type RecordMerchantEvidenceDependencies } from './merchantEvidence.js'

const RECOVERY_HEADER = 'x-ocd-recovery-credential'

export interface MerchantEvidenceRouteDependencies extends RecordMerchantEvidenceDependencies {
  authenticateOperation?: typeof authenticateOperation
}

export function createMerchantEvidenceSubmitHandler(deps: MerchantEvidenceRouteDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const credential = c.req.header(RECOVERY_HEADER)
    const op = await (deps.authenticateOperation ?? authenticateOperation)(operationId, credential)
    if (!op) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }

    let input
    try {
      input = parseMerchantEvidenceInput(rawBody)
    } catch (err) {
      return c.json({ error: err instanceof MerchantEvidenceInputError ? err.message : 'invalid merchant evidence input' }, 400)
    }

    let result
    try {
      result = await recordMerchantEvidence(operationId, input, deps)
    } catch (err) {
      if (err instanceof MerchantEvidenceInputError) return c.json({ error: err.message }, 400)
      throw err
    }

    const e = result.evidence
    return c.json(
      {
        evidence_id: e.evidenceId,
        operation_id: e.operationId,
        source: e.source,
        resource_url: e.resourceUrl,
        http_status: e.httpStatus,
        content_type: e.contentType,
        response_body_digest: e.responseBodyDigest,
        response_bytes: e.responseBytes,
        execution_request_id: e.executionRequestId,
        provider_reference: e.providerReference,
        transaction_hash: e.transactionHash,
        recorded_at: e.recordedAt,
        idempotent_replay: !result.created,
      },
      result.created ? 201 : 200
    )
  }
}

export function mountMerchantEvidence(app: Hono, deps: MerchantEvidenceRouteDependencies = {}): void {
  app.post('/operations/:operationId/merchant-evidence', createMerchantEvidenceSubmitHandler(deps))
}
