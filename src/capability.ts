/**
 * capability.ts — one-time finalization capabilities (D2.2).
 *
 * A finalization capability authorizes exactly one thing: "create one
 * Commerce Receipt for this exact preflight lifecycle." It does NOT
 * authorize payment, and it is not a public trust primitive — it is a
 * private bearer secret, generated and consumed entirely server-side.
 *
 * Design:
 *   - 256 bits of crypto-random entropy, base64url-encoded (43 chars).
 *   - The raw token is returned to the caller exactly once (in the paid
 *     preflight response) and NEVER stored — only sha256(token) is stored,
 *     in `finalization_capabilities.capability_hash` (see db.ts). Losing the
 *     raw token means losing the capability; that is intentional.
 *   - Never logged: callers of mintFinalizationCapability/hashCapabilityToken
 *     must not pass the raw value to any logging call, and this module
 *     itself never does.
 *   - Bounded TTL (hours, not months — see FINALIZATION_TTL_HOURS),
 *     configurable via env, always returned to the caller so they know
 *     exactly when it expires.
 *   - Bound to one exact preflight receipt id + digest (checked again at
 *     finalization time, not just at mint time).
 *   - Single-use: consumption is atomic with publishing the resulting
 *     Commerce Receipt (see db.ts's consumeCapabilityAndPublish).
 */
import { randomBytes } from 'node:crypto'
import { createFinalizationCapability, hashCapabilityToken } from './db.js'

const DEFAULT_TTL_HOURS = 24

export function finalizationTtlHours(): number {
  const raw = process.env.FINALIZATION_CAPABILITY_TTL_HOURS
  if (!raw) return DEFAULT_TTL_HOURS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS
}

export interface FinalizationCapability {
  /** Returned to the caller exactly once. Never stored, never logged. */
  token: string
  expiresAt: string
}

/**
 * Mints and durably records a new finalization capability bound to the
 * given (already-published-or-not) PREFLIGHT receipt. Only the SHA-256 hash
 * of the token is persisted.
 */
export async function mintFinalizationCapability(
  preflightReceiptId: string,
  preflightReceiptDigest: string,
  publishCommerce: boolean
): Promise<FinalizationCapability> {
  const token = randomBytes(32).toString('base64url') // 256 bits
  const expiresAt = new Date(Date.now() + finalizationTtlHours() * 60 * 60 * 1000).toISOString()
  await createFinalizationCapability({
    capabilityHash: hashCapabilityToken(token),
    preflightReceiptId,
    preflightReceiptDigest,
    expiresAt,
    publishCommerce,
  })
  return { token, expiresAt }
}

const BEARER_PATTERN = /^Bearer (.+)$/

/** Extracts the raw token from an Authorization header, or null if malformed/absent. */
export function extractBearerCapability(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null
  const match = BEARER_PATTERN.exec(authorizationHeader)
  return match ? (match[1] as string) : null
}
