/**
 * circleWebhookVerification.ts — D3.4C6.
 *
 * Verifies an inbound Circle v2 wallet-notification webhook delivery, per
 * Circle's current official webhook-signature-verification documentation
 * and its own published Node.js verification sample
 * (developers.circle.com/api-reference/verify-webhook-signatures),
 * re-confirmed directly against that sample for this hardening pass:
 *
 *   - signed bytes: the EXACT raw request body (Circle's own docs warn
 *     that "parsing the JSON and re-serializing it changes the byte
 *     order, so the signature no longer matches")
 *   - algorithm: `ECDSA_SHA_256`, verified as SHA-256 over the raw body
 *     against an EC (SPKI/DER) public key
 *   - `X-Circle-Signature`: base64-encoded -- this is Circle's own
 *     documented encoding (their official sample calls
 *     `verifier.verify(publicKey, signature, "base64")` with no
 *     alternative path), not an assumption. This module therefore never
 *     falls back to hex or tries multiple encodings -- a signature that
 *     doesn't decode as valid base64 is fail-closed rejected outright.
 *   - key source: `GET https://api.circle.com/v2/notifications/publicKey/<X-Circle-Key-Id>`
 *     -- unlike Turnkey's fully public JWKS or Crossmint's shared Svix
 *     secret, this endpoint itself requires `Authorization: Bearer
 *     <CIRCLE_API_KEY>` (an authenticated Circle API credential, not a
 *     webhook-specific secret). The returned public key is a
 *     base64-encoded DER (SPKI) key, cacheable indefinitely per `keyId`
 *     per Circle's own documented guidance ("the public key for a given
 *     keyId is static, so cache the result").
 *
 * DOCUMENTED GAP (kept honest, not papered over): current Circle
 * documentation for v2 webhook verification gives no replay-window or
 * timestamp-tolerance guidance of any kind (unlike Turnkey's explicit
 * 5-minute window). This module does not invent one. The actual security
 * model here is deliberately: valid Circle signature + `notificationId`
 * idempotency (via the existing content-addressed provider-evidence store)
 * + the durable execution-binding correlation this webhook must match --
 * not a timestamp check. See docs/PROVIDER_EVIDENCE.md's Circle section.
 *
 * A verified signature proves ONLY "Circle authored this claim" -- it is
 * attributable provider evidence, never independent settlement evidence
 * (see docs/PROVIDER_EVIDENCE.md).
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export const CIRCLE_PUBLIC_KEY_URL_PREFIX = 'https://api.circle.com/v2/notifications/publicKey/'
export const CIRCLE_SIGNATURE_ALGORITHM = 'ECDSA_SHA_256'
/** Circle's own documented encoding for X-Circle-Signature (confirmed via Circle's official verification sample) -- not an assumption, never a fallback to another encoding. */
export const CIRCLE_SIGNATURE_ENCODING = 'base64' as const

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/

export class CircleWebhookVerificationError extends Error {}

export interface CircleWebhookHeaders {
  signature: string | null
  keyId: string | null
}

interface CachedKey {
  publicKeyDer: Buffer
  algorithm: string
}

const keyCache = new Map<string, CachedKey>()

/** Test/ops seam: drops the in-memory public-key cache. */
export function resetCircleKeyCache(): void {
  keyCache.clear()
}

export interface CircleWebhookVerificationDependencies {
  /** Test seam: replaces the real, authenticated Circle public-key fetch. Defaults to a real GET against CIRCLE_PUBLIC_KEY_URL_PREFIX using process.env.CIRCLE_API_KEY. */
  fetchPublicKey?: (keyId: string) => Promise<{ publicKeyDer: Buffer; algorithm: string }>
}

async function defaultFetchPublicKey(keyId: string): Promise<{ publicKeyDer: Buffer; algorithm: string }> {
  const apiKey = process.env.CIRCLE_API_KEY
  if (!apiKey) throw new CircleWebhookVerificationError('CIRCLE_API_KEY is not configured -- cannot fetch the Circle notification public key')
  const response = await fetch(`${CIRCLE_PUBLIC_KEY_URL_PREFIX}${encodeURIComponent(keyId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new CircleWebhookVerificationError(`could not fetch Circle notification public key for keyId "${keyId}" (HTTP ${response.status})`)
  const body = (await response.json()) as { data?: { publicKey?: string; algorithm?: string } }
  const publicKeyB64 = body.data?.publicKey
  const algorithm = body.data?.algorithm
  if (!publicKeyB64 || !algorithm) throw new CircleWebhookVerificationError(`Circle notification public key response for keyId "${keyId}" is missing publicKey/algorithm`)
  return { publicKeyDer: Buffer.from(publicKeyB64, 'base64'), algorithm }
}

async function getPublicKey(keyId: string, deps: CircleWebhookVerificationDependencies): Promise<CachedKey> {
  const cached = keyCache.get(keyId)
  if (cached) return cached
  const fetched = await (deps.fetchPublicKey ?? defaultFetchPublicKey)(keyId)
  keyCache.set(keyId, fetched)
  return fetched
}

/**
 * Verifies one Circle webhook delivery. `rawBody` MUST be the exact bytes
 * Circle sent (not a re-serialized JSON object). Throws
 * CircleWebhookVerificationError on any failure -- fail-closed on a
 * missing header, an unsupported/unexpected algorithm, an unfetchable
 * public key, or a signature that does not verify.
 */
export async function verifyCircleWebhook(rawBody: string, headers: CircleWebhookHeaders, deps: CircleWebhookVerificationDependencies = {}): Promise<void> {
  const { signature, keyId } = headers
  if (!signature || !keyId) {
    throw new CircleWebhookVerificationError('missing one or more required X-Circle-Signature / X-Circle-Key-Id headers')
  }

  const key = await getPublicKey(keyId, deps)
  if (key.algorithm !== CIRCLE_SIGNATURE_ALGORITHM) {
    throw new CircleWebhookVerificationError(`unsupported Circle notification signature algorithm "${key.algorithm}"`)
  }

  // Node's Buffer.from(..., 'base64') is lenient and silently drops
  // invalid characters rather than throwing -- an explicit shape check is
  // what actually makes a malformed signature fail closed here, rather
  // than relying on cryptoVerify() to reject whatever garbage bytes a
  // lenient decode produced (which it still would, but this is the
  // precise, intended rejection point).
  if (!BASE64_PATTERN.test(signature)) {
    throw new CircleWebhookVerificationError('X-Circle-Signature is not validly base64-encoded')
  }
  const signatureBytes = Buffer.from(signature, CIRCLE_SIGNATURE_ENCODING)

  const publicKey = createPublicKey({ key: key.publicKeyDer, format: 'der', type: 'spki' })
  const ok = cryptoVerify('sha256', Buffer.from(rawBody, 'utf8'), publicKey, signatureBytes)
  if (!ok) throw new CircleWebhookVerificationError('Circle webhook signature did not verify')
}
