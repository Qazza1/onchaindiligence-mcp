/**
 * webhookSigning.ts — D2.7B conventional HMAC webhook signing (Section 5).
 *
 * Deliberately the boring, well-understood scheme (Stripe/GitHub-style):
 * HMAC-SHA256 over `${timestamp}.${rawBody}`, hex-encoded, versioned as
 * `v1=<hex>`. No asymmetric crypto, no new algorithm -- see this file's
 * header for why: a webhook delivery only needs to prove "this really came
 * from OCD, with this exact unmodified body, roughly now" to the receiving
 * server, which a shared secret is entirely sufficient for.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'

const SECRET_PREFIX = 'whsec_'

export function generateWebhookSigningSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('base64url')
}

/** `${timestamp}.${rawBody}`, HMAC-SHA256, hex -- the exact bytes a receiver must reproduce. See examples/webhook-receiver.mjs for a working verifier. */
export function signWebhookDelivery(secret: string, timestampSeconds: string, rawBody: string): string {
  const signedPayload = `${timestampSeconds}.${rawBody}`
  const digestHex = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex')
  return `v1=${digestHex}`
}

/** For the customer's own verification code (documented, not used server-side -- server-side we always compute fresh and compare, see webhookSigning.ts's sibling in examples/). */
export function verifyWebhookSignature(secret: string, timestampSeconds: string, rawBody: string, signatureHeader: string): boolean {
  const expected = signWebhookDelivery(secret, timestampSeconds, rawBody)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader, 'utf8')
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)
}
