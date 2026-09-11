/**
 * turnkeyWebhookRoute.ts — D3.4C3.
 *
 * Inbound Turnkey `transaction:status` webhook receiver. This is the ONLY
 * entry point that turns a Turnkey push notification into durable OCD
 * provider evidence. It never trusts anything the webhook says about which
 * OCD operation it belongs to:
 *
 *   sendTransactionStatusId
 *     -> turnkey:<sendTransactionStatusId>          (correlationReference)
 *     -> durable execution_bindings.provider_reference lookup
 *     -> the operation that binding belongs to
 *     -> recordProviderEvidence()
 *
 * If no durable binding matches, the claim is NOT attached to any
 * operation -- it is acknowledged (so Turnkey does not retry a delivery
 * OCD has no use for) but not recorded, per D3.4C3's explicit instruction
 * not to guess a correlation.
 *
 * Duplicate deliveries (Turnkey retries, same X-Turnkey-Event-Id) are
 * handled entirely by createProviderEvidence()'s existing content-addressed
 * idempotency (evidenceId = contentId(...)) -- a retry of the identical
 * message produces the identical evidenceId and is a safe no-op. No
 * separate webhook-event-id table is introduced.
 */
import type { Context, Hono } from 'hono'
import { verifyTurnkeyWebhook, TurnkeyWebhookVerificationError, type TurnkeyWebhookVerificationDependencies } from './turnkeyWebhookVerification.js'
import { isTerminalTurnkeyStatus, parseTurnkeyWebhookEvidenceInput, recordProviderEvidence, ProviderEvidenceInputError, type RecordProviderEvidenceDependencies } from './providerEvidence.js'
import { getExecutionBindingByProviderReference } from './executionBinding.js'
import { emitFindingsUpdated } from './webhookEvents.js'

export interface TurnkeyWebhookRouteDependencies extends RecordProviderEvidenceDependencies, TurnkeyWebhookVerificationDependencies {
  verifyTurnkeyWebhook?: typeof verifyTurnkeyWebhook
  getExecutionBindingByProviderReference?: typeof getExecutionBindingByProviderReference
  emitFindingsUpdated?: typeof emitFindingsUpdated
}

export function createTurnkeyWebhookHandler(deps: TurnkeyWebhookRouteDependencies = {}) {
  return async function (c: Context) {
    // Verification MUST run over the exact raw bytes Turnkey sent --
    // c.req.text() returns the untouched body string, never a re-serialized
    // JSON object (see turnkeyWebhookVerification.ts's header note).
    const rawBody = await c.req.text()
    try {
      await (deps.verifyTurnkeyWebhook ?? verifyTurnkeyWebhook)(
        rawBody,
        {
          signature: c.req.header('x-turnkey-signature') ?? null,
          signatureKeyId: c.req.header('x-turnkey-signature-key-id') ?? null,
          signatureAlgorithm: c.req.header('x-turnkey-signature-algorithm') ?? null,
          signatureVersion: c.req.header('x-turnkey-signature-version') ?? null,
          eventId: c.req.header('x-turnkey-event-id') ?? null,
          timestamp: c.req.header('x-turnkey-timestamp') ?? null,
        },
        deps
      )
    } catch (err) {
      if (err instanceof TurnkeyWebhookVerificationError) return c.json({ error: err.message }, 401)
      throw err
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }

    const status = typeof body === 'object' && body !== null && 'msg' in body ? (body as { msg?: { status?: unknown } }).msg?.status : undefined
    if (!isTerminalTurnkeyStatus(status)) {
      // BROADCASTING (or any other non-terminal/unrecognized status): a
      // valid signed delivery, acknowledged so Turnkey does not retry it,
      // but there is no terminal claim to record yet.
      return c.json({ acknowledged: true, recorded: false, reason: 'non-terminal transaction status' }, 202)
    }

    const eventId = c.req.header('x-turnkey-event-id') ?? ''
    let input
    try {
      input = parseTurnkeyWebhookEvidenceInput(body, eventId)
    } catch (err) {
      if (err instanceof ProviderEvidenceInputError) return c.json({ error: err.message }, 400)
      throw err
    }

    const binding = await (deps.getExecutionBindingByProviderReference ?? getExecutionBindingByProviderReference)(input.correlationReference!)
    if (!binding) {
      // No durable execution binding references this sendTransactionStatusId
      // -- never attach the claim to an arbitrary/guessed operation.
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

export function mountTurnkeyWebhook(app: Hono, deps: TurnkeyWebhookRouteDependencies = {}): void {
  app.post('/webhooks/turnkey/transaction-status', createTurnkeyWebhookHandler(deps))
}
