/**
 * accounts.ts — durable account identity (D2.7A, Section 6).
 *
 * A completely separate concept from operation.ts's per-operation
 * `recovery_credential`, AND from the existing `operator/` directory (the
 * D2.2B manual payment console UI, a different sense of "operator"
 * entirely) -- an account is the identity a caller authenticates AS (across
 * many operations), used only to scope the NEW private history/recovery-
 * center read surface (GET /me/operations, GET /me/operations/:id). It
 * grants no payment authority, no recovery-credential-equivalent access to
 * any single operation's lifecycle-mutating routes, and no evidentiary
 * claim -- exactly as narrow as operation.ts's own credential, just scoped
 * to "list/read the operations I created" instead of "resume this one
 * operation". Same discipline: only the SHA-256 hash of the raw API key is
 * ever persisted; the raw key is returned to the caller exactly once.
 */
import { randomBytes, createHash } from 'node:crypto'
import { createAccount as insertAccount, getAccountByApiKeyHash, type AccountRecord } from './db.js'

const ACCOUNT_ID_PREFIX = 'OCD-ACC-'

function generateAccountId(): string {
  return ACCOUNT_ID_PREFIX + randomBytes(16).toString('base64url')
}

function generateApiKey(): string {
  return randomBytes(32).toString('base64url') // 256 bits, same as recovery_credential/finalization capabilities
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

export interface CreatedAccount {
  accountId: string
  /** Returned to the caller exactly once. Never stored, never logged. */
  apiKey: string
}

/** Creates a fresh account identity. Free -- no payment, no policy, no link to any operation yet. */
export async function createAccount(): Promise<CreatedAccount> {
  const accountId = generateAccountId()
  const apiKey = generateApiKey()
  await insertAccount({ accountId, apiKeyHash: hashApiKey(apiKey) })
  return { accountId, apiKey }
}

const BEARER_PREFIX = 'Bearer '

/**
 * Resolves an `Authorization: Bearer <api_key>` header to the account it
 * belongs to. Looks up by the hash directly (same pattern as
 * finalization_capabilities' capability_hash primary-key lookup) rather than
 * requiring the caller to also state their own account_id -- an API key is
 * self-identifying by design. `timingSafeEqual` is not needed here (unlike
 * authenticateOperation()'s "prove you hold THIS operation's secret" check
 * against an already-fetched row): this is an equality lookup on a value
 * that is itself a digest of a 256-bit secret, not a byte-by-byte compare
 * whose timing could leak which prefix bytes matched.
 */
export async function authenticateAccount(
  authorizationHeader: string | null | undefined,
  deps: { getAccountByApiKeyHash?: (hash: string) => Promise<AccountRecord | null> } = {}
): Promise<AccountRecord | null> {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) return null
  const rawKey = authorizationHeader.slice(BEARER_PREFIX.length).trim()
  if (!rawKey) return null
  return (deps.getAccountByApiKeyHash ?? getAccountByApiKeyHash)(hashApiKey(rawKey))
}
