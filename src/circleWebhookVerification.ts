/**
 * circleWebhookVerification.ts — D3.4C6.
 *
 * Verifies an inbound Circle v2 wallet-notification webhook delivery,
 * confirmed against current official Circle documentation
 * (developers.circle.com) at implementation time:
 *
 *   - signed bytes: the EXACT raw request body (Circle's own docs warn
 *     that "parsing the JSON and re-serializing it changes the byte
 *     order, so the signature no longer matches")
 *   - algorithm: ECDSA_SHA_256, `X-Circle-Signature` header
 *   - key source: `GET https://api.circle.com/v2/notifications/publicKey/<X-Circle-Key-Id>`
 *     -- UNLIKE Turnkey's fully public JWKS or Crossmint's shared Svix
 *     secret, this endpoint itself requires `Authorization: Bearer
 *     <CIRCLE_API_KEY>` (an authenticated Circle API credential, not a
 *     webhook-specific secret). Confirmed, not assumed. The returned
 *     public key is a base64-encoded DER (SPKI) key, cacheable
 *     indefinitely per `keyId` per Circle's own documented guidance
 *     ("the public key for a given keyId is static, so cache the
 *     result").
 *
 * DOCUMENTED GAP (kept honest, not papered over): current Circle
 * documentation for v2 webhook verification gives no replay-window or
 * timestamp-tolerance guidance of any kind (unlike Turnkey's explicit
 * 5-minute window). This module does not invent one -- verification here
 * is signature-validity only. See docs/PROVIDER_EVIDENCE.md's Circle
 * section for how this is handled (correlation + content-addressed
 * idempotency, not a timestamp check).
 *
 * UNCONFIRMED DETAIL, FLAGGED: the exact encoding of the
 * `X-Circle-Signature` header value (base64 vs hex) was not found in any
 * fetched official page during this implementation. This module assumes
 * base64 (the same encoding Circle uses for the public key itself, and
 * the most common convention for this class of API) -- this MUST be
 * confirmed against Circle's own official code sample or a live test
 * delivery before this path is trusted with a real Circle webhook
 * endpoint. See this file's `CIRCLE_SIGNATURE_ENCODING` constant, the one
 * place to change if this assumption is wrong.
 *
 * A verified signature proves ONLY "Circle authored this claim" -- it is
 * attributable provider evidence, never independent settlement evidence
 * (see docs/PROVIDER_EVIDENCE.md).
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export const CIRCLE_PUBLIC_KEY_URL_PREFIX = 'https://api.circle.com/v2/notifications/publicKey/'
export const CIRCLE_SIGNATURE_ALGORITHM = 'ECDSA_SHA_256'
/** UNCONFIRMED assumption -- see this file's header. The one place to change if Circle's real encoding turns out to be hex. */
export const CIRCLE_SIGNATURE_ENCODING: 'base64' | 'hex' = 'base64'

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

  let signatureBytes: Buffer
  try {
    signatureBytes = Buffer.from(signature, CIRCLE_SIGNATURE_ENCODING)
  } catch {
    throw new CircleWebhookVerificationError('X-Circle-Signature could not be decoded')
  }

  const publicKey = createPublicKey({ key: key.publicKeyDer, format: 'der', type: 'spki' })
  const ok = cryptoVerify('sha256', Buffer.from(rawBody, 'utf8'), publicKey, signatureBytes)
  if (!ok) throw new CircleWebhookVerificationError('Circle webhook signature did not verify')
}
