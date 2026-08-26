/**
 * attest.ts — signs results by calling the HTTP API's /attest endpoint.
 * ------------------------------------------------------------------
 * WHY A NETWORK CALL RATHER THAN LOCAL SIGNING:
 *
 * The Ed25519 signing key lives in exactly one place — the HTTP API's
 * ATTESTATION_PRIVATE_KEY env var. Copying it into this deployment would
 * double the key's exposure for the sake of ~200ms. For a product whose entire
 * claim is "the signature means something", that's the wrong trade. So we POST
 * the result to the API's free /attest route and get back the same signed
 * envelope the HTTP routes return — one key, one trust anchor, and the result
 * verifies at /verify unchanged.
 *
 * FAILURE BEHAVIOUR: index.ts probes the authenticated readiness endpoint
 * before x402 payment middleware. If signing still fails after that preflight,
 * this module throws and the tool returns an explicit error. It never returns
 * an unsigned success-shaped paid result.
 */

const ATTEST_URL =
  process.env.ATTEST_URL || 'https://api.onchaindiligence.com/attest'
const ATTEST_SERVICE_TOKEN = process.env.ATTESTATION_SERVICE_TOKEN || ''
const ATTEST_READY_URL = /\/attest\/?$/.test(ATTEST_URL)
  ? ATTEST_URL.replace(/\/attest\/?$/, '/attest/ready')
  : `${ATTEST_URL.replace(/\/$/, '')}/ready`

const ATTEST_TIMEOUT_MS = 4000
const READY_CACHE_MS = 5000
let readyCache = { checkedAt: 0, ready: false }

export interface Attestation {
  signed: boolean
  issued_at?: string
  key_id?: string
  algorithm?: string
  signature?: string
  signing_input_hint?: string
  error?: string
}

export interface SignedEnvelope<T = unknown> {
  data: T
  attestation: Attestation
}

/**
 * Wrap a result in a signed attestation envelope.
 *
 * Throws on signing failure. An unsigned envelope is never a successful paid
 * tool result.
 */
export async function attest<T>(data: T): Promise<SignedEnvelope<T>> {
  if (!ATTEST_SERVICE_TOKEN) {
    throw new Error('attestation service credential is not configured')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEST_TIMEOUT_MS)

  try {
    const res = await fetch(ATTEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATTEST_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({ evidence: data }),
      signal: controller.signal,
    })

    if (!res.ok) {
      // res.json() is typed as returning `unknown` — cast explicitly rather
      // than relying on inference through .catch().
      const detail = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(detail.error || `attestation service returned ${res.status}`)
    }

    const envelope = (await res.json()) as SignedEnvelope<T>
    if (!envelope?.attestation?.signed || !envelope.attestation.signature) {
      throw new Error('attestation service returned an unsigned envelope')
    }
    return envelope
  } catch (err: any) {
    const reason =
      err?.name === 'AbortError'
        ? 'attestation service timed out'
        : err?.message || 'attestation service unreachable'
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

/** Authenticated, cached readiness probe used before payment middleware. */
export async function attestationReady(): Promise<boolean> {
  if (!ATTEST_SERVICE_TOKEN) return false
  const now = Date.now()
  if (now - readyCache.checkedAt < READY_CACHE_MS) return readyCache.ready

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(ATTEST_READY_URL, {
      headers: { Authorization: `Bearer ${ATTEST_SERVICE_TOKEN}` },
      signal: controller.signal,
    })
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean }
    readyCache = { checkedAt: now, ready: res.ok && body.ready === true }
  } catch {
    readyCache = { checkedAt: now, ready: false }
  } finally {
    clearTimeout(timer)
  }
  return readyCache.ready
}
