/**
 * webhookRoute.ts — D2.7B HTTP surface (Sections 2/8) + the internal cron
 * entry point that drives retries (Section 6).
 *
 *   POST   /me/webhooks                      account-api-key-gated
 *   GET    /me/webhooks                      account-api-key-gated
 *   DELETE /me/webhooks/:id                  account-api-key-gated
 *   GET    /me/webhooks/:id/deliveries       account-api-key-gated
 *   POST   /internal/webhooks/deliver        shared-secret-gated (Vercel Cron)
 *
 * Entirely additive, on top of D2.7A's account identity. Nothing here can
 * touch a commerce operation's own state -- it only reads/writes
 * webhook_endpoints/webhook_events/webhook_deliveries.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { authenticateAccount } from './accounts.js'
import { generateWebhookSigningSecret } from './webhookSigning.js'
import { processDueDeliveries } from './webhookDelivery.js'
import {
  createWebhookEndpoint,
  countActiveWebhookEndpointsForAccount,
  listWebhookEndpointsForAccount,
  getWebhookEndpoint,
  deleteWebhookEndpointForAccount,
  listDeliveriesForWebhook,
} from './db.js'

export interface WebhookRouteDependencies {
  authenticateAccount?: typeof authenticateAccount
  createWebhookEndpoint?: typeof createWebhookEndpoint
  countActiveWebhookEndpointsForAccount?: typeof countActiveWebhookEndpointsForAccount
  listWebhookEndpointsForAccount?: typeof listWebhookEndpointsForAccount
  getWebhookEndpoint?: typeof getWebhookEndpoint
  deleteWebhookEndpointForAccount?: typeof deleteWebhookEndpointForAccount
  listDeliveriesForWebhook?: typeof listDeliveriesForWebhook
  processDueDeliveries?: typeof processDueDeliveries
}

const MAX_ACTIVE_ENDPOINTS_PER_ACCOUNT = 5
const WEBHOOK_ID_PREFIX = 'OCD-WHK-'

function generateWebhookId(): string {
  return WEBHOOK_ID_PREFIX + randomBytes(16).toString('base64url')
}

/**
 * Basic SSRF hygiene, not exhaustive (no DNS-rebinding protection, no redirect
 * following check at delivery time) -- deliberately the smallest safe check
 * for a first slice: HTTPS only, and reject the obvious internal/loopback
 * hostnames a customer would never legitimately register.
 */
function isAcceptableWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'url must be a valid absolute URL' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'url must use https://' }
  const host = parsed.hostname.toLowerCase()
  const blocked = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
  if (blocked) return { ok: false, reason: 'url must not point at a local/internal address' }
  return { ok: true, url: parsed.toString() }
}

type RequireAccountResult = { account: NonNullable<Awaited<ReturnType<typeof authenticateAccount>>>; response: null } | { account: null; response: Response }

async function requireAccount(c: Context, deps: WebhookRouteDependencies): Promise<RequireAccountResult> {
  const account = await (deps.authenticateAccount ?? authenticateAccount)(c.req.header('authorization'))
  if (!account) {
    c.header('WWW-Authenticate', 'Bearer realm="account-history"')
    return { account: null, response: c.json({ error: 'missing or invalid account API key' }, 401) }
  }
  return { account, response: null }
}

function toPublicEndpoint(e: Awaited<ReturnType<typeof getWebhookEndpoint>>) {
  if (!e) return null
  // Deliberately excludes signingSecret -- see db/schema.sql's D2.7B comment.
  return { webhook_id: e.webhookId, url: e.url, status: e.status, created_at: e.createdAt }
}

export function createWebhooksCreateHandler(deps: WebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400)
    }
    const url = typeof (body as any)?.url === 'string' ? (body as any).url : null
    if (!url) return c.json({ error: 'url is required' }, 400)
    const checked = isAcceptableWebhookUrl(url)
    if (!checked.ok) return c.json({ error: checked.reason }, 400)

    const activeCount = await (deps.countActiveWebhookEndpointsForAccount ?? countActiveWebhookEndpointsForAccount)(account.accountId)
    if (activeCount >= MAX_ACTIVE_ENDPOINTS_PER_ACCOUNT) {
      return c.json({ error: `this account already has the maximum of ${MAX_ACTIVE_ENDPOINTS_PER_ACCOUNT} active webhook endpoints` }, 409)
    }

    const signingSecret = generateWebhookSigningSecret()
    const endpoint = await (deps.createWebhookEndpoint ?? createWebhookEndpoint)({ webhookId: generateWebhookId(), accountId: account.accountId, url: checked.url, signingSecret })
    // The ONLY place the raw signing secret is ever returned.
    return c.json({ webhook_id: endpoint.webhookId, url: endpoint.url, status: endpoint.status, created_at: endpoint.createdAt, signing_secret: signingSecret }, 201)
  }
}

export function createWebhooksListHandler(deps: WebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response
    const endpoints = await (deps.listWebhookEndpointsForAccount ?? listWebhookEndpointsForAccount)(account.accountId)
    return c.json({ webhooks: endpoints.map((e) => toPublicEndpoint(e)) })
  }
}

export function createWebhooksDeleteHandler(deps: WebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response
    const webhookId = c.req.param('id') ?? ''
    const deleted = await (deps.deleteWebhookEndpointForAccount ?? deleteWebhookEndpointForAccount)(webhookId, account.accountId)
    if (!deleted) return c.json({ error: 'unknown webhook' }, 404)
    return c.json({ deleted: true })
  }
}

export function createWebhookDeliveriesListHandler(deps: WebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const { account, response } = await requireAccount(c, deps)
    if (!account) return response
    const webhookId = c.req.param('id') ?? ''
    const endpoint = await (deps.getWebhookEndpoint ?? getWebhookEndpoint)(webhookId)
    if (!endpoint || endpoint.accountId !== account.accountId) return c.json({ error: 'unknown webhook' }, 404)

    const limitParam = c.req.query('limit')
    const limit = limitParam ? Math.min(Math.max(Number.parseInt(limitParam, 10) || 20, 1), 100) : 20
    const deliveries = await (deps.listDeliveriesForWebhook ?? listDeliveriesForWebhook)(webhookId, limit)
    return c.json({
      deliveries: deliveries.map((d) => ({
        event_id: d.eventId,
        event_type: d.eventType,
        operation_id: d.operationId,
        created_at: d.createdAt,
        attempt_count: d.attemptCount,
        last_http_status: d.lastHttpStatus,
        status: d.status,
        delivered_at: d.deliveredAt,
      })),
    })
  }
}

/**
 * Cron auth: a shared secret, same discipline as onchaindilige's
 * internalAuth.ts (constant-time compare of a Bearer token's hash). Not the
 * account API key -- this route is not account-scoped, it drives retries
 * for ALL accounts.
 *
 * D2.7 production-readiness correction: Vercel Cron Jobs do NOT let a
 * project send an arbitrary custom header -- the ONLY automatic
 * authentication Vercel provides is that when a `CRON_SECRET` environment
 * variable exists on the project, Vercel itself sends
 * `Authorization: Bearer <CRON_SECRET>` on every cron invocation. A
 * differently-named env var (the original `WEBHOOK_WORKER_SECRET`) is never
 * populated into that header by Vercel automatically -- relying on it alone
 * would leave the real Vercel Cron invocation unauthenticated in
 * production. This handler now accepts a match against EITHER configured
 * secret: `CRON_SECRET` (Vercel's own mechanism) or `WEBHOOK_WORKER_SECRET`
 * (kept for manual/non-Vercel invocation -- e.g. an ops runbook curl, or a
 * different scheduler later). At least one must be configured, or this
 * fails closed.
 */
export function createInternalWebhookDeliverHandler(deps: WebhookRouteDependencies = {}) {
  return async function (c: Context) {
    const candidates = [process.env.CRON_SECRET, process.env.WEBHOOK_WORKER_SECRET].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (candidates.length === 0) return c.json({ error: 'neither CRON_SECRET nor WEBHOOK_WORKER_SECRET is configured' }, 500)

    const header = c.req.header('authorization') || ''
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const presentedHash = createHash('sha256').update(presented, 'utf8').digest()
    const authorized = candidates.some((expected) => {
      const expectedHash = createHash('sha256').update(expected, 'utf8').digest()
      return presentedHash.length === expectedHash.length && timingSafeEqual(presentedHash, expectedHash)
    })
    if (!authorized) return c.json({ error: 'unauthorized' }, 401)

    const result = await (deps.processDueDeliveries ?? processDueDeliveries)(50)
    return c.json(result)
  }
}

export function mountWebhooks(app: Hono, deps: WebhookRouteDependencies = {}): void {
  app.post('/me/webhooks', createWebhooksCreateHandler(deps))
  app.get('/me/webhooks', createWebhooksListHandler(deps))
  app.delete('/me/webhooks/:id', createWebhooksDeleteHandler(deps))
  app.get('/me/webhooks/:id/deliveries', createWebhookDeliveriesListHandler(deps))
  // Both verbs: Vercel Cron Jobs issue a GET by default; some setups POST.
  // Auth (the shared secret) is identical either way -- see the handler.
  app.post('/internal/webhooks/deliver', createInternalWebhookDeliverHandler(deps))
  app.get('/internal/webhooks/deliver', createInternalWebhookDeliverHandler(deps))
}
