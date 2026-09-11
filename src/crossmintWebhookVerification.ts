/**
 * crossmintWebhookVerification.ts — D3.4C4.
 *
 * Verifies an inbound Crossmint wallet-transfer webhook delivery using the
 * official `svix` package, per current official Crossmint documentation
 * (docs.crossmint.com/wallets/guides/webhooks, re-confirmed immediately
 * before this implementation): Crossmint delivers webhooks signed via Svix,
 * verified over the `svix-id` / `svix-timestamp` / `svix-signature` headers
 * and the exact raw request body, using the endpoint's own signing secret
 * from the Crossmint Console. The docs explicitly say to use the raw body
 * and the official svix library rather than re-deriving the HMAC scheme by
 * hand -- this module does exactly that instead of inventing custom
 * signature logic, per this project's own instruction to prefer the
 * official library when it fits cleanly.
 *
 * A verified signature proves ONLY "this provider claim was delivered by
 * the configured Crossmint webhook endpoint" -- it is attributable
 * provider evidence, never independent settlement evidence (see
 * docs/PROVIDER_EVIDENCE.md). This module has no opinion about operation
 * correlation or settlement truth; see crossmintWebhookRoute.ts and
 * executionBinding.ts's getExecutionBindingByProviderReference() for that.
 */
import { Webhook, WebhookVerificationError } from 'svix'

export class CrossmintWebhookVerificationError extends Error {}

export interface CrossmintWebhookHeaders {
  svixId: string | null
  svixTimestamp: string | null
  svixSignature: string | null
}

/**
 * Verifies one Crossmint webhook delivery. `rawBody` MUST be the exact
 * bytes Crossmint sent (not a re-serialized JSON object) -- Svix's own
 * verification fails otherwise, per its own documented signed-input rule
 * (id.timestamp.body).
 *
 * `signingSecret` is the endpoint's own Crossmint Console signing secret
 * (the `whsec_...`-shaped value), passed in explicitly rather than read
 * from `process.env` here -- callers (crossmintWebhookRoute.ts) own where
 * it comes from, matching this module's narrow, injectable-dependency
 * discipline.
 *
 * Returns nothing on success -- the `svix` package's own `Webhook.verify()`
 * validates the signature and returns `undefined` (it does NOT hand back a
 * parsed payload, despite what its type signature might suggest at a
 * glance; confirmed by reading `svix`'s own source, not assumed). Callers
 * must parse `rawBody` themselves after this returns without throwing.
 * Throws CrossmintWebhookVerificationError on any failure -- fail-closed on
 * a missing header or a signature/timestamp Svix itself rejects (Svix's own
 * library enforces its documented replay-timestamp tolerance internally;
 * this module does not re-implement or second-guess that window).
 */
export function verifyCrossmintWebhook(rawBody: string, headers: CrossmintWebhookHeaders, signingSecret: string): void {
  const { svixId, svixTimestamp, svixSignature } = headers
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new CrossmintWebhookVerificationError('missing one or more required svix-id / svix-timestamp / svix-signature headers')
  }
  const wh = new Webhook(signingSecret)
  try {
    wh.verify(rawBody, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature })
  } catch (err) {
    if (err instanceof WebhookVerificationError) throw new CrossmintWebhookVerificationError(err.message)
    throw err
  }
}
