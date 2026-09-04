/**
 * safeError.ts — D2.2B1: safe extraction of a 402-rejection reason for
 * display in the operator UI, after a paid replay unexpectedly stays 402
 * (e.g. the CDP facilitator's /verify rejecting the request — see
 * src/discovery.ts's MAX_X402_DESCRIPTION_LENGTH comment for the incident
 * this was built for).
 *
 * ALLOWLIST, not denylist: this reads exactly three known string field
 * names off the parsed response body and nothing else, so it is safe by
 * construction regardless of what else the body might someday contain (a
 * payment payload, a signature, a capability). Never spread/stringify the
 * whole body into the UI or a log line.
 */

const SAFE_402_FIELDS = ['error', 'errorReason', 'invalidReason'] as const

/**
 * `body` should be the already-`.json()`-parsed 402 response (or `null` if
 * parsing failed) — this function does no fetching/parsing itself, which is
 * what keeps it unit-testable with plain objects, no Response/DOM needed.
 */
export function extractSafe402Detail(body: unknown, routeLabel: string): string {
  if (typeof body !== 'object' || body === null) {
    return `${routeLabel}: 402 rejection (response body could not be safely parsed)`
  }
  const obj = body as Record<string, unknown>
  const parts: string[] = []
  for (const field of SAFE_402_FIELDS) {
    const value = obj[field]
    if (typeof value === 'string' && value.length > 0) parts.push(`${field}: ${value}`)
  }
  if (parts.length === 0) {
    return `${routeLabel}: 402 rejection (no recognized error field in the response)`
  }
  return `${routeLabel}: ${parts.join('; ')}`
}
