/**
 * turnkeyWebhookVerification.ts — D3.4C3.
 *
 * Verifies an inbound Turnkey `transaction:status` webhook delivery against
 * Turnkey's own public JWKS, per docs.turnkey.com/features/webhooks/
 * verify-signatures (re-confirmed live at D3.4C3-PREP and again immediately
 * before this implementation):
 *
 *   - signed bytes: `v1.ed25519.<X-Turnkey-Signature-Key-Id>.<X-Turnkey-Timestamp>.<X-Turnkey-Event-Id>.<raw body>`
 *   - algorithm: ed25519, hex-encoded signature (X-Turnkey-Signature)
 *   - key source: GET https://api.turnkey.com/public/v1/discovery/webhooks/jwks
 *     (unauthenticated, standard JWKS: `keys[].kid` / `keys[].x` base64url Ed25519 public key)
 *   - replay window: 5 minutes (documented recommendation)
 *
 * A verified signature proves ONLY "Turnkey authored this claim" -- it is
 * attributable provider evidence, never independent settlement evidence
 * (see docs/PROVIDER_EVIDENCE.md). This module has no opinion about
 * operation correlation or settlement truth; see turnkeyWebhookRoute.ts and
 * executionBinding.ts's getExecutionBindingByProviderReference() for that.
 *
 * Verification is done against the EXACT raw request body bytes -- per
 * Turnkey's own docs, "re-serializing parsed JSON, changing whitespace, or
 * changing key order will cause verification to fail" -- so every caller
 * MUST pass the untouched raw body string, never a re-stringified JSON
 * object.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export const TURNKEY_WEBHOOK_JWKS_URL = 'https://api.turnkey.com/public/v1/discovery/webhooks/jwks'
export const TURNKEY_SIGNATURE_ALGORITHM = 'ed25519'
export const TURNKEY_SIGNATURE_VERSION = 'v1'
export const TURNKEY_REPLAY_WINDOW_MS = 5 * 60 * 1000

export class TurnkeyWebhookVerificationError extends Error {}

export interface TurnkeyWebhookHeaders {
  signature: string | null
  signatureKeyId: string | null
  signatureAlgorithm: string | null
  signatureVersion: string | null
  eventId: string | null
  timestamp: string | null
}

interface Jwk {
  kid: string
  x: string
  kty?: string
  crv?: string
}

interface JwksCacheEntry {
  keys: Jwk[]
  fetchedAt: number
  maxAgeMs: number
}

let jwksCache: JwksCacheEntry | null = null

/** Test seam: replaces the injected fetch implementation used to reach the JWKS endpoint. Never used for anything other than the JWKS GET. */
export interface TurnkeyWebhookVerificationDependencies {
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
}

function parseCacheControlMaxAgeMs(header: string | null): number {
  if (!header) return 5 * 60 * 1000 // conservative default when the endpoint omits Cache-Control
  const match = /max-age=(\d+)/i.exec(header)
  return match ? Number(match[1]) * 1000 : 5 * 60 * 1000
}

async function getJwksKeys(deps: TurnkeyWebhookVerificationDependencies, forceRefresh: boolean): Promise<Jwk[]> {
  const now = (deps.now ?? Date.now)()
  if (!forceRefresh && jwksCache && now - jwksCache.fetchedAt < jwksCache.maxAgeMs) {
    return jwksCache.keys
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(TURNKEY_WEBHOOK_JWKS_URL)
  if (!response.ok) throw new TurnkeyWebhookVerificationError(`could not fetch Turnkey webhook JWKS (HTTP ${response.status})`)
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache = { keys, fetchedAt: now, maxAgeMs: parseCacheControlMaxAgeMs(response.headers.get('cache-control')) }
  return keys
}

/** Test/ops seam: drops the in-memory JWKS cache, forcing the next verification to refetch. */
export function resetTurnkeyJwksCache(): void {
  jwksCache = null
}

function ed25519PublicKeyFromJwk(jwk: Jwk) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
}

/**
 * Verifies one Turnkey webhook delivery. `rawBody` MUST be the exact bytes
 * Turnkey sent (not a re-serialized JSON object). Returns silently on
 * success; throws TurnkeyWebhookVerificationError with a specific reason on
 * any failure -- fail-closed on an unsupported algorithm/version, a missing
 * header, a stale timestamp, an unknown key id (after one cache refresh),
 * or a signature that does not verify.
 */
export async function verifyTurnkeyWebhook(
  rawBody: string,
  headers: TurnkeyWebhookHeaders,
  deps: TurnkeyWebhookVerificationDependencies = {}
): Promise<void> {
  const { signature, signatureKeyId, signatureAlgorithm, signatureVersion, eventId, timestamp } = headers
  if (!signature || !signatureKeyId || !signatureAlgorithm || !signatureVersion || !eventId || !timestamp) {
    throw new TurnkeyWebhookVerificationError('missing one or more required X-Turnkey-Signature* / X-Turnkey-Event-Id / X-Turnkey-Timestamp headers')
  }
  // Fail closed on any algorithm/version this module was not written
  // against -- never fall back to a "best effort" verification of an
  // unrecognized scheme.
  if (signatureAlgorithm !== TURNKEY_SIGNATURE_ALGORITHM) {
    throw new TurnkeyWebhookVerificationError(`unsupported X-Turnkey-Signature-Algorithm "${signatureAlgorithm}"`)
  }
  if (signatureVersion !== TURNKEY_SIGNATURE_VERSION) {
    throw new TurnkeyWebhookVerificationError(`unsupported X-Turnkey-Signature-Version "${signatureVersion}"`)
  }

  const now = (deps.now ?? Date.now)()
  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs)) throw new TurnkeyWebhookVerificationError('X-Turnkey-Timestamp is not a valid number')
  if (Math.abs(now - timestampMs) > TURNKEY_REPLAY_WINDOW_MS) {
    throw new TurnkeyWebhookVerificationError(`X-Turnkey-Timestamp is outside the ${TURNKEY_REPLAY_WINDOW_MS}ms replay window`)
  }

  if (!/^[0-9a-fA-F]+$/.test(signature) || signature.length !== 128) {
    throw new TurnkeyWebhookVerificationError('X-Turnkey-Signature must be a 64-byte hex-encoded ed25519 signature')
  }
  const signatureBytes = Buffer.from(signature, 'hex')

  const signedInput = `v1.ed25519.${signatureKeyId}.${timestamp}.${eventId}.${rawBody}`

  let keys = await getJwksKeys(deps, false)
  let jwk = keys.find((k) => k.kid === signatureKeyId)
  if (!jwk) {
    // Unknown kid: refresh once before rejecting (documented key-rotation behavior).
    keys = await getJwksKeys(deps, true)
    jwk = keys.find((k) => k.kid === signatureKeyId)
  }
  if (!jwk) throw new TurnkeyWebhookVerificationError(`no Turnkey webhook signing key found for kid "${signatureKeyId}"`)

  const publicKey = ed25519PublicKeyFromJwk(jwk)
  const ok = cryptoVerify(null, Buffer.from(signedInput, 'utf8'), publicKey, signatureBytes)
  if (!ok) throw new TurnkeyWebhookVerificationError('Turnkey webhook signature did not verify')
}
