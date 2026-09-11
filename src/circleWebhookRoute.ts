/**
 * circleWebhookRoute.ts — D3.4C6.
 *
 * Inbound Circle v2 notification receiver. This is the ONLY entry point
 * that turns a Circle push notification into durable OCD provider
 * evidence. It never trusts anything the notification says about which
 * OCD operation it belongs to:
 *
 *   notification.id
 *     -> circle:<id>                                (correlationReference)
 *     -> durable execution_bindings.provider_reference lookup
 *     -> the operation that binding belongs to
 *     -> recordProviderEvidence()
 *
 * If no durable binding matches, the claim is NOT attached to any
 * operation -- it is acknowledged (so Circle does not retry a delivery
 * OCD has no use for) but not recorded, mirroring D3.4C3/D3.4C4/D3.4C5's
 * discipline exactly.
 *
 * Duplicate deliveries are handled entirely by createProviderEvidence()'s
 * existing content-addressed idempotency -- a retry of the identical
 * notification produces the identical evidenceId and is a safe no-op. No
 * separate notification-id table is introduced.
 *
 * Only `transactions.outbound` is parsed as a provider execution claim
 * (see providerEvidence.ts's Circle section header). `transactions.inbound`
 * and any other notification type are acknowledged without being recorded.
 */
import type { Context, Hono } from 'hono'
import { verifyCircleWebhook, CircleWebhookVerificationError, type CircleWebhookVerificationDependencies } from './circleWebhookVerification.js'
import { isCircleOutboundNotification, parseCircleWebhookEvidenceInput, recordProviderEvidence, ProviderEvidenceInputError, type RecordProviderEvidenceDependencies } from './providerEvidence.js'
import { getExecutionBindingByProviderReference } from './executionBinding.js'
import { emitFindingsUpdated } from './webhookEvents.js'

export interface CircleWebhookRouteDependencies extends RecordProviderEvidenceDependencies, CircleWebhookVerificationDependencies {
  verifyCircleWebhook?: typeof verifyCircleWebhook
  getExecutionBindingByProviderReference?: typeof getExecutionBindingByProviderReference
  emitFindingsUpdated?: typeof emitFindingsUpdated
}

export function createCircleWebhookHandler(deps: CircleWebhookRouteDependencies = {}) {
  return async function (c: Context) {
    // Verification MUST run over the exact raw bytes Circle sent --
    // c.req.text() returns the untouched body string, never a
    // re-serialized JSON object (see circleWebhookVerification.ts's
    // header note -- Circle's own docs warn re-serializing breaks this).
    const rawBody = await c.req.text()
    try {
      await (deps.verifyCircleWebhook ?? verifyCircleWebhook)(
        rawBody,
        { signature: c.req.header('x-circle-signature') ?? null, keyId: c.req.header('x-circle-key-id') ?? null },
        deps
      )
    } catch (err) {
      if (err instanceof CircleWebhookVerificationError) return c.json({ error: err.message }, 401)
      throw err
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }

    const notificationType = typeof body === 'object' && body !== null && 'notificationType' in body ? (body as { notificationType?: unknown }).notificationType : undefined
    if (!isCircleOutboundNotification(notificationType)) {
      // A validly-signed Circle notification OCD has no use for as
      // provider execution evidence (transactions.inbound, or any other
      // notification type) -- acknowledged, never recorded.
      return c.json({ acknowledged: true, recorded: false, reason: 'not a transactions.outbound notification' }, 202)
    }

    let input
    try {
      input = parseCircleWebhookEvidenceInput(body)
    } catch (err) {
      if (err instanceof ProviderEvidenceInputError) {
        // A non-terminal state (INITIATED/QUEUED/SENT/CONFIRMED) is a
        // valid, expected delivery -- acknowledge it rather than erroring,
        // so Circle does not treat it as a failed delivery and retry.
        if (/non-terminal/.test(err.message)) return c.json({ acknowledged: true, recorded: false, reason: 'non-terminal transaction state' }, 202)
        return c.json({ error: err.message }, 400)
      }
      throw err
    }

    const binding = await (deps.getExecutionBindingByProviderReference ?? getExecutionBindingByProviderReference)(input.correlationReference!)
    if (!binding) {
      // No durable execution binding references this transaction id --
      // never attach the claim to an arbitrary/guessed operation.
      return c.json({ acknowledged: true, recorded: false, reason: 'no durable execution binding matches this provider_reference' }, 202)
    }

    try {
      const result = await recordProviderEvidence(binding.operationId, { ...input, executionRequestId: binding.executionRequestId }, deps)
      const e = result.evidence
      await (deps.emitFindingsUpdated ?? emitFindingsUpdated)(binding.operationId)
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

export function mountCircleWebhook(app: Hono, deps: CircleWebhookRouteDependencies = {}): void {
  app.post('/webhooks/circle/transaction-status', createCircleWebhookHandler(deps))
}
