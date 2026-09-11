/** Recovery-credential-gated provider-claim recording. This is the narrow
 * operation surface needed for failed x402 claims, which cannot use the
 * transaction-required finalize route. It never submits/finalizes a payment. */
import type { Context, Hono } from 'hono'
import { authenticateOperation } from './operation.js'
import { parseProviderEvidenceInput, recordProviderEvidence, ProviderEvidenceInputError, type RecordProviderEvidenceDependencies } from './providerEvidence.js'
import { emitFindingsUpdated } from './webhookEvents.js'

const RECOVERY_HEADER = 'x-ocd-recovery-credential'
export interface ProviderEvidenceRouteDependencies extends RecordProviderEvidenceDependencies {
  authenticateOperation?: typeof authenticateOperation
  emitFindingsUpdated?: typeof emitFindingsUpdated
}

export function createProviderEvidenceSubmitHandler(deps: ProviderEvidenceRouteDependencies = {}) {
  return async function (c: Context) {
    const operationId = c.req.param('operationId') ?? ''
    const operation = await (deps.authenticateOperation ?? authenticateOperation)(operationId, c.req.header(RECOVERY_HEADER))
    if (!operation) {
      c.header('WWW-Authenticate', 'Bearer realm="operation-recovery"')
      return c.json({ error: 'unknown operation or invalid recovery credential' }, 401)
    }
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body must be valid JSON' }, 400) }
    try {
      const result = await recordProviderEvidence(operationId, parseProviderEvidenceInput(body), deps)
      const e = result.evidence
      // The claim is durable before the canonical D3.3 set is recalculated.
      // Delivery is DB-only/non-fatal under the existing webhook contract.
      await (deps.emitFindingsUpdated ?? emitFindingsUpdated)(operationId)
      return c.json({
        evidence_id: e.evidenceId, operation_id: e.operationId, provider: e.provider, claimed_state: e.claimedState,
        transaction_hash: e.transactionHash, execution_request_id: e.executionRequestId, source_authentication: e.sourceAuthentication,
        recorded_at: e.recordedAt, idempotent_replay: !result.created,
      }, result.created ? 201 : 200)
    } catch (err) {
      if (err instanceof ProviderEvidenceInputError) return c.json({ error: err.message }, 400)
      throw err
    }
  }
}

export function mountProviderEvidence(app: Hono, deps: ProviderEvidenceRouteDependencies = {}): void {
  app.post('/operations/:operationId/provider-evidence', createProviderEvidenceSubmitHandler(deps))
}
