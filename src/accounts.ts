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
import { verifyToken } from '@clerk/backend'
import { createAccount as insertAccount, getAccountByApiKeyHash, getAccountByWorkspaceApiKeyHash, getAccountForWorkspace, getWorkspaceForClerkUser, createWorkspaceForClerkUser, type AccountRecord, type WorkspaceRecord } from './db.js'

const ACCOUNT_ID_PREFIX = 'OCD-ACC-'

function generateAccountId(): string {
  return ACCOUNT_ID_PREFIX + randomBytes(16).toString('base64url')
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

export function generateApiKey(): string { return `ocd_${randomBytes(32).toString('base64url')}` }
export function generateId(prefix: string): string { return prefix + randomBytes(16).toString('base64url') }

/** Resolves a Clerk session to one durable, V1 single-user workspace. */
export async function authenticateDashboardSession(rawToken: string): Promise<{ account: AccountRecord; workspace: WorkspaceRecord; clerkUserId: string } | null> {
  if (!rawToken.includes('.')) return null
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) return null
  try {
    const claims = await verifyToken(rawToken, { secretKey, authorizedParties: ['https://app.onchaindiligence.com'] })
    if (!claims?.sub) return null
    const clerkUserId = claims.sub
    let workspace = await getWorkspaceForClerkUser(clerkUserId)
    if (!workspace) workspace = await createWorkspaceForClerkUser({ userId: generateId('OCD-USR-'), clerkUserId, workspaceId: generateId('OCD-WS-'), accountId: generateId(ACCOUNT_ID_PREFIX), internalApiKeyHash: hashApiKey(randomBytes(32).toString('base64url')) })
    const account = await getAccountForWorkspace(workspace.workspaceId)
    return account ? { account, workspace, clerkUserId } : null
  } catch { return null }
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
  const session = await authenticateDashboardSession(rawKey)
  if (session) return session.account
  const hash = hashApiKey(rawKey)
  return (await getAccountByWorkspaceApiKeyHash(hash)) ?? (deps.getAccountByApiKeyHash ?? getAccountByApiKeyHash)(hash)
}
