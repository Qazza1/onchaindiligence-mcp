import type { Context, Hono } from 'hono'
import { authenticateDashboardSession, generateApiKey, generateId, hashApiKey } from './accounts.js'
import { createApiKeyRecord, listApiKeysForWorkspace, renameWorkspaceForClerkUser, revokeApiKeyForWorkspace } from './db.js'

async function session(c: Context) {
  const value = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const resolved = await authenticateDashboardSession(value)
  if (!resolved) return null
  return resolved
}
function invalid(c: Context) { c.header('WWW-Authenticate', 'Bearer realm="dashboard"'); return c.json({ error: 'sign in required' }, 401) }
function name(value: unknown): string | null { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80 ? value.trim() : null }

/** Human-only profile, workspace, and API-key management. Raw keys are only in POST create responses. */
export function mountWorkspace(app: Hono): void {
  app.get('/me', async c => { const s = await session(c); return s ? c.json({ workspace: { workspace_id: s.workspace.workspaceId, name: s.workspace.name } }) : invalid(c) })
  app.patch('/me/workspace', async c => { const s = await session(c); if (!s) return invalid(c); const value = name((await c.req.json().catch(() => null) as any)?.name); if (!value) return c.json({ error: 'workspace name must be 1–80 characters' }, 400); const workspace = await renameWorkspaceForClerkUser(s.clerkUserId, value); return c.json({ workspace: { workspace_id: workspace!.workspaceId, name: workspace!.name } }) })
  app.get('/me/api-keys', async c => { const s = await session(c); return s ? c.json({ api_keys: await listApiKeysForWorkspace(s.workspace.workspaceId) }) : invalid(c) })
  app.post('/me/api-keys', async c => {
    const s = await session(c); if (!s) return invalid(c)
    const keyName = name((await c.req.json().catch(() => null) as any)?.name); if (!keyName) return c.json({ error: 'API key name must be 1–80 characters' }, 400)
    const rawKey = generateApiKey()
    const apiKey = await createApiKeyRecord({ keyId: generateId('OCD-KEY-'), workspaceId: s.workspace.workspaceId, name: keyName, apiKeyHash: hashApiKey(rawKey) })
    return c.json({ api_key: { ...apiKey, value: rawKey } }, 201)
  })
  app.delete('/me/api-keys/:keyId', async c => { const s = await session(c); if (!s) return invalid(c); const revoked = await revokeApiKeyForWorkspace(c.req.param('keyId') ?? '', s.workspace.workspaceId); return revoked ? c.json({ revoked: true }) : c.json({ error: 'unknown active API key' }, 404) })
}
