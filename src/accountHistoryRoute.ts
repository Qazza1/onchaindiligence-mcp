/**
 * accountHistoryRoute.ts — D2.7A private operation history + recovery
 * center HTTP surface.
 *
 *   POST /accounts                         free -- create an account identity
 *   GET  /me/operations                    account-api-key-gated -- bounded recent history
 *   GET  /me/operations/:operationId       account-api-key-gated -- full lifecycle detail + recovery status
 *
 * Entirely additive and separate from the D2.4 recovery-credential-gated
 * routes in lifecycleRoute.ts/lifecycleFinalizeRoute.ts, which are
 * unchanged. Nothing here can mutate an operation, submit a payment, or
 * finalize a receipt -- this is a read-only product surface over existing
 * D2.4 state.
 */
import type { Context, Hono } from 'hono'
import { authenticateAccount, createAccount } from './accounts.js'
import { listOperationsForOwner, getOperationDetailForOwner } from './operationHistory.js'

export interface AccountHistoryDependencies {
  authenticateAccount?: typeof authenticateAccount
  listOperationsForOwner?: typeof listOperationsForOwner
  getOperationDetailForOwner?: typeof getOperationDetailForOwner
}

type RequireAccountResult = { account: NonNullable<Awaited<ReturnType<typeof authenticateAccount>>>; response: null } | { account: null; response: Response }

async function requireAccount(c: Context, deps: AccountHistoryDependencies): Promise<RequireAccountResult> {
  const account = await (deps.authenticateAccount ?? authenticateAccount)(c.req.header('authorization'))
  if (!account) {
    c.header('WWW-Authenticate', 'Bearer realm="account-history"')
    return { account: null, response: c.json({ error: 'missing or invalid account API key' }, 401) }
  }
  return { account, response: null }
}

export async function accountsCreateHandler(c: Context) {
  const created = await createAccount()
  return c.json({ account_id: created.accountId, api_key: created.apiKey }, 201)
}

export function createMeOperationsListHandler(deps: AccountHistoryDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response

    const limitParam = c.req.query('limit')
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
    const before = c.req.query('before') || undefined
    if (limitParam && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      return c.json({ error: 'limit must be a positive integer' }, 400)
    }

    const operations = await (deps.listOperationsForOwner ?? listOperationsForOwner)(account.accountId, { limit, before })
    return c.json({ operations })
  }
}

export function createMeOperationDetailHandler(deps: AccountHistoryDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response

    const operationId = c.req.param('operationId') ?? ''
    const result = await (deps.getOperationDetailForOwner ?? getOperationDetailForOwner)(operationId, account.accountId)
    if (!result.found) {
      // Deliberately identical to "operation exists but belongs to someone
      // else" -- see operationHistory.ts's getOperationDetailForOwner() header.
      return c.json({ error: 'unknown operation' }, 404)
    }
    return c.json(result.detail)
  }
}

export function mountAccountHistory(app: Hono, deps: AccountHistoryDependencies = {}): void {
  app.post('/accounts', accountsCreateHandler)
  app.get('/me/operations', createMeOperationsListHandler(deps))
  app.get('/me/operations/:operationId', createMeOperationDetailHandler(deps))
}
