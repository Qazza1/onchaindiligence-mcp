/**
 * crossmintWebhookRoute.ts — D3.4C4.
 *
 * Inbound Crossmint wallet-transfer webhook receiver. This is the ONLY
 * entry point that turns a Crossmint push notification into durable OCD
 * provider evidence. It never trusts anything the webhook says about which
 * OCD operation it belongs to:
 *
 *   data.transferId
 *     -> crossmint:<transferId>                    (correlationReference)
 *     -> durable execution_bindings.provider_reference lookup
 *     -> the operation that binding belongs to
 *     -> recordProviderEvidence()
 *
 * If no durable binding matches, the claim is NOT attached to any
 * operation -- it is acknowledged (so Crossmint does not retry a delivery
 * OCD has no use for) but not recorded, mirroring D3.4C3's Turnkey
 * discipline exactly.
 *
 * Duplicate deliveries (a Svix/Crossmint retry of the same event) are
 * handled entirely by createProviderEvidence()'s existing content-addressed
 * idempotency -- a retry of the identical message produces the identical
 * evidenceId and is a safe no-op. No separate webhook-event-id table is
 * introduced.
 *
 * Only `wallets.transfer.out` is parsed as a provider execution claim (see
 * providerEvidence.ts's Crossmint section header). `wallets.transfer.in`
 * and `wallets.signer.exported` are real, validly-signed Crossmint events
 * but are acknowledged without being recorded as provider evidence -- they
 * do not describe an OCD-authorized payment's outcome.
 */
import type { Context, Hono } from 'hono'
import { verifyCrossmintWebhook, CrossmintWebhookVerificationError } from './crossmintWebhookVerification.js'
import { isCrossmintOutboundTransferEvent, parseCrossmintWebhookEvidenceInput, recordProviderEvidence, ProviderEvidenceInputError, type RecordProviderEvidenceDependencies } from './providerEvidence.js'
import { getExecutionBindingByProviderReference } from './executionBinding.js'
import { emitFindingsUpdated } from './webhookEvents.js'

export interface CrossmintWebhookRouteDependencies extends RecordProviderEvidenceDependencies {
  verifyCrossmintWebhook?: typeof verifyCrossmintWebhook
  getExecutionBindingByProviderReference?: typeof getExecutionBindingByProviderReference
  emitFindingsUpdated?: typeof emitFindingsUpdated
  /** Test seam / explicit override for the Crossmint Console endpoint signing secret. Defaults to process.env.CROSSMINT_WEBHOOK_SECRET. */
  signingSecret?: string
}

export function createCrossmintWebhookHandler(deps: CrossmintWebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const signingSecret = deps.signingSecret ?? process.env.CROSSMINT_WEBHOOK_SECRET
    if (!signingSecret) {
      // Fail closed: never accept an unverifiable delivery just because
      // deployment configuration is incomplete.
      return c.json({ error: 'Crossmint webhook signing secret is not configured' }, 500)
    }

    // Verification MUST run over the exact raw bytes Crossmint sent --
    // c.req.text() returns the untouched body string, never a re-serialized
    // JSON object (see crossmintWebhookVerification.ts's header note).
    const rawBody = await c.req.text()
    try {
      ;(deps.verifyCrossmintWebhook ?? verifyCrossmintWebhook)(
        rawBody,
        {
          svixId: c.req.header('svix-id') ?? null,
          svixTimestamp: c.req.header('svix-timestamp') ?? null,
          svixSignature: c.req.header('svix-signature') ?? null,
        },
        signingSecret
      )
    } catch (err) {
      if (err instanceof CrossmintWebhookVerificationError) return c.json({ error: err.message }, 401)
      throw err
    }

    // svix's Webhook.verify() only validates the signature -- it does not
    // hand back a parsed payload (see crossmintWebhookVerification.ts).
    // Parse the now-trusted raw body ourselves.
    let verified: unknown
    try {
      verified = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }

    const eventType = typeof verified === 'object' && verified !== null && 'type' in verified ? (verified as { type?: unknown }).type : undefined
    if (!isCrossmintOutboundTransferEvent(eventType)) {
      // A validly-signed Crossmint event OCD has no use for as provider
      // execution evidence (wallets.transfer.in, wallets.signer.exported,
      // or any future event type) -- acknowledged, never recorded.
      return c.json({ acknowledged: true, recorded: false, reason: 'not a wallets.transfer.out event' }, 202)
    }

    const svixEventId = c.req.header('svix-id') ?? ''
    let input
    try {
      input = parseCrossmintWebhookEvidenceInput(verified, svixEventId)
    } catch (err) {
      if (err instanceof ProviderEvidenceInputError) return c.json({ error: err.message }, 400)
      throw err
    }

    const binding = await (deps.getExecutionBindingByProviderReference ?? getExecutionBindingByProviderReference)(input.correlationReference!)
    if (!binding) {
      // No durable execution binding references this transferId -- never
      // attach the claim to an arbitrary/guessed operation.
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

export function mountCrossmintWebhook(app: Hono, deps: CrossmintWebhookRouteDependencies = {}): void {
  app.post('/webhooks/crossmint/transfer', createCrossmintWebhookHandler(deps))
}
