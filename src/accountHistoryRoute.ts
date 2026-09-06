/**
 * accountHistoryRoute.ts — D2.7A private operation history + recovery
 * center HTTP surface, plus D2.7C's investigation/export routes layered
 * on the exact same account-scoped shape.
 *
 *   POST /accounts                                       free -- create an account identity
 *   GET  /me/operations                                  account-api-key-gated -- bounded recent history
 *   GET  /me/operations/:operationId                     account-api-key-gated -- full lifecycle detail + recovery status
 *   GET  /me/operations/:operationId/investigation        account-api-key-gated -- assembled investigation (D2.7C)
 *   GET  /me/operations/:operationId/investigation/export account-api-key-gated -- manifest-wrapped export (D2.7C)
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
import { getInvestigationForOwner, buildInvestigationExport } from './investigation.js'

export interface AccountHistoryDependencies {
  authenticateAccount?: typeof authenticateAccount
  listOperationsForOwner?: typeof listOperationsForOwner
  getOperationDetailForOwner?: typeof getOperationDetailForOwner
  /** Route-level tests inject this wholesale rather than threading investigation.ts's own nested deps (getOperationDetailForOwner/verifyReceipt) through -- see test/d27cInvestigation.ts. */
  getInvestigationForOwner?: typeof getInvestigationForOwner
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

/** D2.7C: same ownership discipline as the detail route above -- 404, indistinguishable from unknown, for anything not owned by the authenticated account. */
export function createMeOperationInvestigationHandler(deps: AccountHistoryDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response

    const operationId = c.req.param('operationId') ?? ''
    const result = await (deps.getInvestigationForOwner ?? getInvestigationForOwner)(operationId, account.accountId)
    if (!result.found) return c.json({ error: 'unknown operation' }, 404)
    return c.json(result.investigation)
  }
}

/** D2.7C: the same investigation, wrapped in the onchaindiligence.investigation.v1 manifest (see investigation.ts's buildInvestigationExport()). */
export function createMeOperationInvestigationExportHandler(deps: AccountHistoryDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response

    const operationId = c.req.param('operationId') ?? ''
    const result = await (deps.getInvestigationForOwner ?? getInvestigationForOwner)(operationId, account.accountId)
    if (!result.found) return c.json({ error: 'unknown operation' }, 404)
    return c.json(buildInvestigationExport({ accountId: account.accountId, investigation: result.investigation }))
  }
}

export function mountAccountHistory(app: Hono, deps: AccountHistoryDependencies = {}): void {
  app.post('/accounts', accountsCreateHandler)
  app.get('/me/operations', createMeOperationsListHandler(deps))
  app.get('/me/operations/:operationId', createMeOperationDetailHandler(deps))
  app.get('/me/operations/:operationId/investigation', createMeOperationInvestigationHandler(deps))
  app.get('/me/operations/:operationId/investigation/export', createMeOperationInvestigationExportHandler(deps))
}
