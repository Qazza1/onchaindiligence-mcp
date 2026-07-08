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
 * FAILURE BEHAVIOUR — read this before changing it:
 *
 * Payment settles in the x402 middleware, BEFORE the handler runs. So by the
 * time we sign, the caller has already paid. If signing fails we must not throw
 * away their money with a 500, and we must not quietly return an unsigned
 * result dressed up as a signed one. Instead we return the data with an
 * explicit `attestation: { signed: false, error }`, so the caller can see
 * exactly what happened and retry.
 */

const ATTEST_URL =
  process.env.ATTEST_URL || 'https://api.onchaindiligence.com/attest'

const ATTEST_TIMEOUT_MS = 4000

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
 * Always resolves — never throws — so a signing outage cannot swallow a paid
 * request. On failure the envelope carries `signed: false` and a reason.
 */
export async function attest<T>(data: T): Promise<SignedEnvelope<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEST_TIMEOUT_MS)

  try {
    const res = await fetch(ATTEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence: data }),
      signal: controller.signal,
    })

    if (!res.ok) {
      // res.json() is typed as returning `unknown` — cast explicitly rather
      // than relying on inference through .catch().
      const detail = (await res.json().catch(() => ({}))) as { error?: string }
      return unsigned(
        data,
        detail.error || `attestation service returned ${res.status}`
      )
    }

    const envelope = (await res.json()) as SignedEnvelope<T>
    if (!envelope?.attestation?.signed || !envelope.attestation.signature) {
      return unsigned(data, 'attestation service returned an unsigned envelope')
    }
    return envelope
  } catch (err: any) {
    const reason =
      err?.name === 'AbortError'
        ? 'attestation service timed out'
        : err?.message || 'attestation service unreachable'
    return unsigned(data, reason)
  } finally {
    clearTimeout(timer)
  }
}

function unsigned<T>(data: T, error: string): SignedEnvelope<T> {
  return {
    data,
    attestation: {
      signed: false,
      error:
        `${error}. The check below was performed, but could not be signed. ` +
        `Retry to obtain a verifiable attestation.`,
    },
  }
}
