/**
 * d27bWebhooks.ts — D2.7B account-scoped outbound webhooks: focused
 * coverage per the task's Section 11 (5 items).
 *
 * Run with: npx tsx test/d27bWebhooks.ts
 *
 * Fully offline: HTTP routes are exercised through the real Hono app
 * (mountWebhooks) with injected dependency fakes; emitOperationEvent()/
 * attemptDelivery()/processDueDeliveries() are exercised directly against
 * in-memory fakes reproducing the real UNIQUE-constraint semantics (same
 * pattern as test/d24ExecutionBinding.ts's makeFakeStore()) -- no Postgres,
 * no real network.
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountWebhooks, type WebhookRouteDependencies } from '../src/webhookRoute.js'
import { signWebhookDelivery, verifyWebhookSignature, generateWebhookSigningSecret } from '../src/webhookSigning.js'
import { emitOperationEvent } from '../src/webhookEvents.js'
import { attemptDelivery, processDueDeliveries, buildWebhookEnvelope } from '../src/webhookDelivery.js'
import type { AccountRecord, WebhookEventRecord, WebhookEndpointRecord, WebhookDeliveryRecord } from '../src/db.js'

const ACCOUNT_A: AccountRecord = { accountId: 'OCD-ACC-aaaa', apiKeyHash: 'hash-a', createdAt: new Date().toISOString() }
const ACCOUNT_B: AccountRecord = { accountId: 'OCD-ACC-bbbb', apiKeyHash: 'hash-b', createdAt: new Date().toISOString() }
function fakeAuthenticateAccount(h: string | null | undefined): Promise<AccountRecord | null> {
  if (h === 'Bearer key-a') return Promise.resolve(ACCOUNT_A)
  if (h === 'Bearer key-b') return Promise.resolve(ACCOUNT_B)
  return Promise.resolve(null)
}
function app(deps: WebhookRouteDependencies) {
  const a = new Hono()
  mountWebhooks(a, deps)
  return a
}

// --- 1. account A cannot access account B's webhook -----------------------

{
  const WEBHOOK_ID = 'OCD-WHK-owned-by-a'
  const endpoint: WebhookEndpointRecord = { webhookId: WEBHOOK_ID, accountId: ACCOUNT_A.accountId, url: 'https://customer.example/hook', signingSecret: 'super-secret-signing-value', status: 'active', createdAt: new Date().toISOString() }
  const deliveries: WebhookDeliveryRecord[] = [{ deliveryId: 'OCD-DLV-x', eventId: 'OCD-EVT-x', webhookId: WEBHOOK_ID, status: 'delivered', attemptCount: 1, nextAttemptAt: new Date().toISOString(), lastHttpStatus: 200, lastError: null, createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() }]

  const deps: WebhookRouteDependencies = {
    authenticateAccount: fakeAuthenticateAccount as any,
    // Real db.ts semantics: DELETE ... WHERE webhook_id = $1 AND account_id = $2 -- only returns true when the ids match.
    deleteWebhookEndpointForAccount: async (webhookId, accountId) => webhookId === WEBHOOK_ID && accountId === endpoint.accountId,
    getWebhookEndpoint: async (webhookId) => (webhookId === WEBHOOK_ID ? endpoint : null),
    listDeliveriesForWebhook: async () => deliveries.map((d) => ({ ...d, eventType: 'operation.receipt_produced', operationId: 'OCD-OP-x' })),
  }

  const deleteAsOwner = await app(deps).request(`/me/webhooks/${WEBHOOK_ID}`, { method: 'DELETE', headers: { authorization: 'Bearer key-a' } })
  assert.equal(deleteAsOwner.status, 200, 'the owning account must be able to delete its own webhook')

  const deleteAsOther = await app(deps).request(`/me/webhooks/${WEBHOOK_ID}`, { method: 'DELETE', headers: { authorization: 'Bearer key-b' } })
  assert.equal(deleteAsOther.status, 404, 'a different account must not be able to delete a webhook it does not own')

  const deliveriesAsOwner = await app(deps).request(`/me/webhooks/${WEBHOOK_ID}/deliveries`, { headers: { authorization: 'Bearer key-a' } })
  assert.equal(deliveriesAsOwner.status, 200, 'the owning account must see its own webhook\'s delivery history')

  const deliveriesAsOther = await app(deps).request(`/me/webhooks/${WEBHOOK_ID}/deliveries`, { headers: { authorization: 'Bearer key-b' } })
  assert.equal(deliveriesAsOther.status, 404, 'a different account must not be able to read delivery history for a webhook it does not own')

  const noAuth = await app(deps).request(`/me/webhooks/${WEBHOOK_ID}/deliveries`)
  assert.equal(noAuth.status, 401, 'no credential at all must be rejected before ownership is ever checked')
}
console.log('ok  account A cannot delete or read delivery history for a webhook owned by account B (404, indistinguishable from unknown); missing credentials are rejected with 401')

// --- 2. emitted event is signed correctly ----------------------------------

{
  const secret = generateWebhookSigningSecret()
  assert.match(secret, /^whsec_/)
  const envelope = buildWebhookEnvelope({ eventId: 'OCD-EVT-1', type: 'operation.receipt_produced', accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-1', createdAt: new Date().toISOString(), data: { receipt_id: 'OCD-RCP-1' } })
  const rawBody = JSON.stringify(envelope)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signWebhookDelivery(secret, timestamp, rawBody)
  assert.match(signature, /^v1=[0-9a-f]{64}$/)
  assert.ok(verifyWebhookSignature(secret, timestamp, rawBody, signature), 'a receiver computing the same HMAC over timestamp+body with the correct secret must verify')
  assert.ok(!verifyWebhookSignature(secret, timestamp, rawBody + 'tampered', signature), 'a modified body must fail verification')
  assert.ok(!verifyWebhookSignature('wrong-secret', timestamp, rawBody, signature), 'the wrong secret must fail verification')
  assert.ok(!verifyWebhookSignature(secret, String(Number(timestamp) + 1), rawBody, signature), 'a different timestamp must fail verification (the timestamp is part of the signed payload)')
}
console.log('ok  webhook deliveries are signed with a versioned HMAC-SHA256 (v1=<hex>) that a receiver can independently verify')

// --- 3. retry uses the same event id and does not duplicate the logical event ---

{
  const events = new Map<string, WebhookEventRecord>() // key: operationId\0type\0dedupeKey
  const deliveries = new Map<string, WebhookDeliveryRecord>() // key: eventId\0webhookId
  const endpoint: WebhookEndpointRecord = { webhookId: 'OCD-WHK-1', accountId: ACCOUNT_A.accountId, url: 'https://customer.example/hook', signingSecret: 's', status: 'active', createdAt: new Date().toISOString() }
  let nextEventSeq = 0

  const deps = {
    createWebhookEvent: async (params: any) => {
      const key = `${params.operationId}\0${params.type}\0${params.dedupeKey}`
      const existing = events.get(key)
      if (existing) return { created: false, event: existing }
      const event: WebhookEventRecord = { eventId: `OCD-EVT-${nextEventSeq++}`, accountId: params.accountId, operationId: params.operationId, type: params.type, dedupeKey: params.dedupeKey, data: params.data, createdAt: new Date().toISOString() }
      events.set(key, event)
      return { created: true, event }
    },
    createWebhookDelivery: async (params: any) => {
      const key = `${params.eventId}\0${params.webhookId}`
      const existing = deliveries.get(key)
      if (existing) return { created: false, delivery: existing }
      const delivery: WebhookDeliveryRecord = { deliveryId: params.deliveryId, eventId: params.eventId, webhookId: params.webhookId, status: 'pending', attemptCount: 0, nextAttemptAt: new Date().toISOString(), lastHttpStatus: null, lastError: null, createdAt: new Date().toISOString(), deliveredAt: null }
      deliveries.set(key, delivery)
      return { created: true, delivery }
    },
    listActiveWebhookEndpointsForAccount: async () => [endpoint],
  }

  await emitOperationEvent({ accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-retry-test', type: 'operation.execution_updated', dedupeKey: 'transaction_known', data: { execution_state: 'transaction_known' } }, deps)
  assert.equal(events.size, 1)
  assert.equal(deliveries.size, 1)
  const firstEventId = [...events.values()][0].eventId

  // Simulate the SAME lifecycle transition being retried (e.g. a resumed
  // request re-running the exact same state-update call site).
  await emitOperationEvent({ accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-retry-test', type: 'operation.execution_updated', dedupeKey: 'transaction_known', data: { execution_state: 'transaction_known' } }, deps)
  assert.equal(events.size, 1, 'retrying the same lifecycle transition must not create a second event')
  assert.equal(deliveries.size, 1, 'retrying must not create a second delivery for the same event/endpoint pair')
  assert.equal([...events.values()][0].eventId, firstEventId, 'the event id must be stable across the retry')

  // A genuinely DIFFERENT transition for the same operation must still get its own event.
  await emitOperationEvent({ accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-retry-test', type: 'operation.execution_updated', dedupeKey: 'manual_recovery_required', data: { execution_state: 'manual_recovery_required' } }, deps)
  assert.equal(events.size, 2, 'a genuinely different lifecycle transition must still produce a new event')
}
console.log('ok  retrying the same lifecycle transition reuses the same event id and creates no duplicate event or delivery; a genuinely new transition still gets its own event')

// --- D2.7B correction, test 1: emitting a lifecycle event enqueues delivery without outbound fetch ---

let enqueueOnlyEvent!: WebhookEventRecord
let enqueueOnlyDelivery!: WebhookDeliveryRecord
let enqueueOnlyEndpoint!: WebhookEndpointRecord
{
  const events = new Map<string, WebhookEventRecord>()
  const deliveries = new Map<string, WebhookDeliveryRecord>()
  const endpoint: WebhookEndpointRecord = { webhookId: 'OCD-WHK-enqueue-only', accountId: ACCOUNT_A.accountId, url: 'https://customer.example/hook', signingSecret: 's', status: 'active', createdAt: new Date().toISOString() }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('emitOperationEvent must never perform outbound HTTP -- delivery is the cron\'s job now')
  }) as typeof fetch

  try {
    const deps = {
      createWebhookEvent: async (params: any) => {
        const event: WebhookEventRecord = { eventId: 'OCD-EVT-enqueue-only', accountId: params.accountId, operationId: params.operationId, type: params.type, dedupeKey: params.dedupeKey, data: params.data, createdAt: new Date().toISOString() }
        events.set(event.eventId, event)
        return { created: true, event }
      },
      createWebhookDelivery: async (params: any) => {
        const delivery: WebhookDeliveryRecord = { deliveryId: params.deliveryId, eventId: params.eventId, webhookId: params.webhookId, status: 'pending', attemptCount: 0, nextAttemptAt: new Date().toISOString(), lastHttpStatus: null, lastError: null, createdAt: new Date().toISOString(), deliveredAt: null }
        deliveries.set(delivery.deliveryId, delivery)
        return { created: true, delivery }
      },
      listActiveWebhookEndpointsForAccount: async () => [endpoint],
    }

    await emitOperationEvent({ accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-enqueue-only', type: 'operation.receipt_produced', dedupeKey: 'OCD-RCP-enqueue-only', data: { receipt_id: 'OCD-RCP-enqueue-only' } }, deps)

    assert.equal(events.size, 1, 'the event must still be enqueued')
    assert.equal(deliveries.size, 1, 'a delivery row must still be created')
    const delivery = [...deliveries.values()][0]
    assert.equal(delivery.status, 'pending', 'the delivery must be left pending -- no inline attempt was made')
    assert.equal(delivery.attemptCount, 0, 'no attempt has been made yet')
    assert.ok(new Date(delivery.nextAttemptAt).getTime() <= Date.now() + 1000, 'next_attempt_at must be ~now, so the cron picks it up on its very next tick')

    // Store these for the next test, which simulates the cron picking this exact row up.
    enqueueOnlyEvent = [...events.values()][0]
    enqueueOnlyDelivery = delivery
    enqueueOnlyEndpoint = endpoint
  } finally {
    globalThis.fetch = originalFetch
  }
}
console.log('ok  emitting a lifecycle event enqueues an event + pending delivery WITHOUT making any outbound fetch call')

// --- D2.7B correction, test 2: cron processes that delivery normally ------

{
  let deliveredHttpStatus: number | null = null
  let sawOutboundRequest = false
  const deps = {
    listDueWebhookDeliveries: async () => [enqueueOnlyDelivery],
    getWebhookEventById: async (eventId: string) => (eventId === enqueueOnlyEvent.eventId ? enqueueOnlyEvent : null),
    getWebhookEndpoint: async (webhookId: string) => (webhookId === enqueueOnlyEndpoint.webhookId ? enqueueOnlyEndpoint : null),
    markWebhookDeliveryDelivered: async (_deliveryId: string, httpStatus: number) => {
      deliveredHttpStatus = httpStatus
    },
    markWebhookDeliveryRetry: async () => assert.fail('must not need a retry -- the fake endpoint returns 200'),
    markWebhookDeliveryFailed: async () => assert.fail('must not fail -- the fake endpoint returns 200'),
    fetchImpl: (async () => {
      sawOutboundRequest = true
      return new Response(null, { status: 200 })
    }) as any,
  }

  const result = await processDueDeliveries(50, deps)
  assert.equal(result.attempted, 1, 'the cron must attempt exactly the one due delivery')
  assert.ok(sawOutboundRequest, 'the cron (not the original request) is what makes the outbound HTTP call')
  assert.equal(deliveredHttpStatus, 200)
}
console.log('ok  the cron\'s processDueDeliveries() picks up an enqueued-only delivery and delivers it normally')

// --- 4. secrets are absent from the payload --------------------------------

{
  const secret = generateWebhookSigningSecret()
  const envelope = buildWebhookEnvelope({
    eventId: 'OCD-EVT-2',
    type: 'operation.execution_updated',
    accountId: ACCOUNT_A.accountId,
    operationId: 'OCD-OP-2',
    createdAt: new Date().toISOString(),
    data: { execution_state: 'transaction_known', execution_request_id: 'OCD-EXEC-1', provider_reference: 'paybox:req-1' },
  })
  const serialized = JSON.stringify(envelope)
  assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the signing secret itself must never appear in the payload it signs')
  assert.doesNotMatch(serialized, /recovery_credential|api_key|capability_token|paybox.*credential|x_payment|x-payment/i)

  // The list endpoint response (GET /me/webhooks) must never include signing_secret.
  const storedEndpoint: WebhookEndpointRecord = { webhookId: 'OCD-WHK-list-test', accountId: ACCOUNT_A.accountId, url: 'https://customer.example/hook', signingSecret: 'must-never-leak-in-list', status: 'active', createdAt: new Date().toISOString() }
  const listRes = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    listWebhookEndpointsForAccount: async () => [storedEndpoint],
  }).request('/me/webhooks', { headers: { authorization: 'Bearer key-a' } })
  assert.equal(listRes.status, 200)
  const listBody = (await listRes.json()) as any
  assert.deepEqual(Object.keys(listBody.webhooks[0]).sort(), ['created_at', 'status', 'url', 'webhook_id'], 'the list response must be exactly this closed field set -- no signing_secret')
  assert.doesNotMatch(JSON.stringify(listBody), /must-never-leak-in-list/)

  // The creation response is the ONE place the secret is returned.
  const createRes = await app({
    authenticateAccount: fakeAuthenticateAccount as any,
    countActiveWebhookEndpointsForAccount: async () => 0,
    createWebhookEndpoint: async (params: any) => ({ webhookId: 'OCD-WHK-new', accountId: params.accountId, url: params.url, signingSecret: params.signingSecret, status: 'active' as const, createdAt: new Date().toISOString() }),
  }).request('/me/webhooks', { method: 'POST', headers: { authorization: 'Bearer key-a', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://customer.example/webhooks/ocd' }) })
  assert.equal(createRes.status, 201)
  const createBody = (await createRes.json()) as any
  assert.deepEqual(Object.keys(createBody).sort(), ['created_at', 'signing_secret', 'status', 'url', 'webhook_id'])
  assert.ok(createBody.signing_secret.startsWith('whsec_'))
}
console.log('ok  the signing secret never appears in a signed payload or the list response; it is returned exactly once, at creation')

// --- 5. successful delivery becomes delivered ------------------------------

{
  const endpoint: WebhookEndpointRecord = { webhookId: 'OCD-WHK-2', accountId: ACCOUNT_A.accountId, url: 'https://customer.example/hook', signingSecret: generateWebhookSigningSecret(), status: 'active', createdAt: new Date().toISOString() }
  const event: WebhookEventRecord = { eventId: 'OCD-EVT-3', accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-3', type: 'operation.receipt_produced', dedupeKey: 'OCD-RCP-3', data: { receipt_id: 'OCD-RCP-3', verification_state: 'VALID' }, createdAt: new Date().toISOString() }
  let delivery: WebhookDeliveryRecord = { deliveryId: 'OCD-DLV-1', eventId: event.eventId, webhookId: endpoint.webhookId, status: 'pending', attemptCount: 0, nextAttemptAt: new Date().toISOString(), lastHttpStatus: null, lastError: null, createdAt: new Date().toISOString(), deliveredAt: null }

  let receivedSignatureValid = false
  const deps = {
    fetchImpl: (async (url: any, init: any) => {
      const timestamp = init.headers['x-ocd-webhook-timestamp']
      const signature = init.headers['x-ocd-webhook-signature']
      receivedSignatureValid = verifyWebhookSignature(endpoint.signingSecret, timestamp, init.body, signature)
      return new Response(null, { status: 200 })
    }) as any,
    markWebhookDeliveryDelivered: async (deliveryId: string, httpStatus: number) => {
      delivery = { ...delivery, status: 'delivered', attemptCount: delivery.attemptCount + 1, lastHttpStatus: httpStatus, deliveredAt: new Date().toISOString() }
    },
    markWebhookDeliveryRetry: async () => assert.fail('a successful delivery must not be marked for retry'),
    markWebhookDeliveryFailed: async () => assert.fail('a successful delivery must not be marked failed'),
  }

  await attemptDelivery(delivery, event, endpoint, deps)
  assert.ok(receivedSignatureValid, 'the receiver must be able to independently verify the delivered signature')
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.lastHttpStatus, 200)
  assert.ok(delivery.deliveredAt)
}
console.log('ok  a successful delivery (HTTP 2xx) is marked delivered, and its signature independently verifies')

// --- bonus: a failing delivery retries with backoff, then gives up after MAX_ATTEMPTS ---

{
  const endpoint: WebhookEndpointRecord = { webhookId: 'OCD-WHK-3', accountId: ACCOUNT_A.accountId, url: 'https://customer.example/down', signingSecret: generateWebhookSigningSecret(), status: 'active', createdAt: new Date().toISOString() }
  const event: WebhookEventRecord = { eventId: 'OCD-EVT-4', accountId: ACCOUNT_A.accountId, operationId: 'OCD-OP-4', type: 'operation.execution_updated', dedupeKey: 'manual_recovery_required', data: {}, createdAt: new Date().toISOString() }
  let delivery: WebhookDeliveryRecord = { deliveryId: 'OCD-DLV-2', eventId: event.eventId, webhookId: endpoint.webhookId, status: 'pending', attemptCount: 0, nextAttemptAt: new Date().toISOString(), lastHttpStatus: null, lastError: null, createdAt: new Date().toISOString(), deliveredAt: null }

  const deps = {
    fetchImpl: (async () => new Response(null, { status: 500 })) as any,
    markWebhookDeliveryDelivered: async () => assert.fail('must never be delivered'),
    markWebhookDeliveryRetry: async (deliveryId: string, nextAttemptAt: string, httpStatus: number | null, error: string | null) => {
      delivery = { ...delivery, status: 'pending', attemptCount: delivery.attemptCount + 1, nextAttemptAt, lastHttpStatus: httpStatus, lastError: error }
    },
    markWebhookDeliveryFailed: async (deliveryId: string, httpStatus: number | null, error: string | null) => {
      delivery = { ...delivery, status: 'failed', attemptCount: delivery.attemptCount + 1, lastHttpStatus: httpStatus, lastError: error }
    },
  }

  await attemptDelivery(delivery, event, endpoint, deps) // attempt 1 -> retry
  assert.equal(delivery.status, 'pending')
  assert.equal(delivery.attemptCount, 1)
  await attemptDelivery(delivery, event, endpoint, deps) // attempt 2 -> retry
  await attemptDelivery(delivery, event, endpoint, deps) // attempt 3 -> retry
  assert.equal(delivery.status, 'pending')
  assert.equal(delivery.attemptCount, 3)
  await attemptDelivery(delivery, event, endpoint, deps) // attempt 4 -> failed, bounded
  assert.equal(delivery.status, 'failed', 'retries must be bounded, never forever')
  assert.equal(delivery.attemptCount, 4)
}
console.log('ok  a persistently failing delivery retries with backoff and is marked failed after bounded attempts, never retried forever')

console.log('\nAll D2.7B webhook tests passed.')
