/**
 * webhookDelivery.ts — D2.7B delivery worker (Section 6).
 *
 * No background worker/scheduler/queue existed anywhere in this codebase
 * before D2.7B (checked: no cron, no outbox, no HMAC utility). This is the
 * smallest durable, DB-backed mechanism consistent with the rest of the
 * architecture (same style as lifecycleSteps.ts's claim/complete rows):
 * webhook_deliveries IS the outbox. Two things drive it:
 *   1. An immediate best-effort attempt right after an event is enqueued
 *      (attemptDelivery(), called inline from webhookEvents.ts) -- fast
 *      path for the common case of a healthy customer endpoint.
 *   2. processDueDeliveries(), invoked by a Vercel Cron hitting
 *      POST /internal/webhooks/deliver (see webhookRoute.ts) on a schedule
 *      -- catches anything the immediate attempt missed or that failed and
 *      is due for retry.
 * Neither path is ever awaited by the request that changed operation
 * state -- a slow/down customer endpoint can only affect delivery rows,
 * never operation execution/finalization (Section 6's explicit requirement).
 */
import {
  markWebhookDeliveryDelivered,
  markWebhookDeliveryRetry,
  markWebhookDeliveryFailed,
  listDueWebhookDeliveries,
  getWebhookEndpoint,
  getWebhookEventById,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEventRecord,
} from './db.js'
import { signWebhookDelivery } from './webhookSigning.js'

/** Immediate attempt, then 1min, then 5min, then 30min -- 4 attempts total, then failed. Matches Section 6's suggested policy exactly. */
const RETRY_DELAYS_SECONDS = [60, 300, 1800]
const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1
const DELIVERY_TIMEOUT_MS = 8000

/** Test seam: every real dependency attemptDelivery()/processDueDeliveries() touch, injectable so offline tests can exercise the real retry/backoff/signing logic without Postgres or real network I/O -- same convention as executionBinding.ts's ExecutionBindingDependencies. */
export interface WebhookDeliveryDependencies {
  markWebhookDeliveryDelivered?: typeof markWebhookDeliveryDelivered
  markWebhookDeliveryRetry?: typeof markWebhookDeliveryRetry
  markWebhookDeliveryFailed?: typeof markWebhookDeliveryFailed
  listDueWebhookDeliveries?: typeof listDueWebhookDeliveries
  getWebhookEndpoint?: typeof getWebhookEndpoint
  getWebhookEventById?: typeof getWebhookEventById
  fetchImpl?: typeof fetch
}

export function buildWebhookEnvelope(params: { eventId: string; type: string; accountId: string; operationId: string; createdAt: string; data: unknown }) {
  return {
    id: params.eventId,
    type: params.type,
    created_at: params.createdAt,
    account_id: params.accountId,
    operation_id: params.operationId,
    data: params.data,
  }
}

async function postWithTimeout(fetchImpl: typeof fetch, url: string, body: string, headers: Record<string, string>): Promise<{ status: number } | { error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal })
    return { status: res.status }
  } catch (err: any) {
    return { error: err?.name === 'AbortError' ? 'delivery timed out' : err?.message || 'delivery failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Attempts ONE delivery of an already-enqueued (event, endpoint) pair.
 * Never throws -- every outcome is written to the delivery row. Safe to
 * call redundantly (e.g. once inline and once from the cron worker
 * moments later): a delivery already `delivered`/`failed` is simply
 * re-attempted again if still `pending`, which is idempotent from the
 * customer's side since the event id and body are identical every time.
 */
export async function attemptDelivery(delivery: WebhookDeliveryRecord, event: WebhookEventRecord, endpoint: WebhookEndpointRecord, deps: WebhookDeliveryDependencies = {}): Promise<void> {
  const markDelivered = deps.markWebhookDeliveryDelivered ?? markWebhookDeliveryDelivered
  const markRetry = deps.markWebhookDeliveryRetry ?? markWebhookDeliveryRetry
  const markFailed = deps.markWebhookDeliveryFailed ?? markWebhookDeliveryFailed
  const fetchImpl = deps.fetchImpl ?? fetch

  if (delivery.status !== 'pending') return
  if (endpoint.status !== 'active') {
    await markFailed(delivery.deliveryId, null, 'endpoint disabled before delivery')
    return
  }

  const envelope = buildWebhookEnvelope({ eventId: event.eventId, type: event.type, accountId: event.accountId, operationId: event.operationId, createdAt: event.createdAt, data: event.data })
  const rawBody = JSON.stringify(envelope)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signWebhookDelivery(endpoint.signingSecret, timestamp, rawBody)

  const result = await postWithTimeout(fetchImpl, endpoint.url, rawBody, {
    'content-type': 'application/json',
    'x-ocd-webhook-id': event.eventId,
    'x-ocd-webhook-timestamp': timestamp,
    'x-ocd-webhook-signature': signature,
  })

  const attemptNumber = delivery.attemptCount + 1 // this attempt, 1-indexed

  if ('status' in result && result.status >= 200 && result.status < 300) {
    await markDelivered(delivery.deliveryId, result.status)
    return
  }

  const httpStatus = 'status' in result ? result.status : null
  const error = 'error' in result ? result.error : `endpoint returned HTTP ${result.status}`

  if (attemptNumber >= MAX_ATTEMPTS) {
    await markFailed(delivery.deliveryId, httpStatus, error)
    return
  }
  const delaySeconds = RETRY_DELAYS_SECONDS[attemptNumber - 1] // attemptNumber=1 (the immediate attempt) failed -> wait RETRY_DELAYS_SECONDS[0] = 60s, etc.
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  await markRetry(delivery.deliveryId, nextAttemptAt, httpStatus, error)
}

/** Cron entry point: processes everything currently due, bounded by `limit`. Returns how many it attempted, for the caller to log/report. */
export async function processDueDeliveries(limit = 50, deps: WebhookDeliveryDependencies = {}): Promise<{ attempted: number }> {
  const listDue = deps.listDueWebhookDeliveries ?? listDueWebhookDeliveries
  const getEndpoint = deps.getWebhookEndpoint ?? getWebhookEndpoint
  const getEvent = deps.getWebhookEventById ?? getWebhookEventById
  const markFailed = deps.markWebhookDeliveryFailed ?? markWebhookDeliveryFailed

  const due = await listDue(limit)
  let attempted = 0
  for (const delivery of due) {
    const [event, endpoint] = await Promise.all([getEvent(delivery.eventId), getEndpoint(delivery.webhookId)])
    if (!event || !endpoint) {
      // Endpoint was deleted (cascades deliveries -- shouldn't reach here)
      // or an event row is somehow missing; either way, nothing safe to
      // retry against. Mark failed rather than looping on it forever.
      await markFailed(delivery.deliveryId, null, 'event or endpoint no longer exists')
      continue
    }
    await attemptDelivery(delivery, event, endpoint, deps)
    attempted++
  }
  return { attempted }
}
