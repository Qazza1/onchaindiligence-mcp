/**
 * webhookEvents.ts — D2.7B event emission (Sections 3/4/7).
 *
 * Five meaningful lifecycle events, each derived from EXISTING D2.4 state
 * (never a parallel/invented lifecycle model):
 *   operation.preflight_completed  <- preflight_state -> 'completed'
 *   operation.execution_updated    <- execution_state transitions
 *   operation.recovery_required    <- deriveRecoveryStatus().needsAttention (D2.7A, reused as-is)
 *   operation.settlement_updated   <- a new commerce_observations row
 *   operation.receipt_produced     <- a Commerce receipt is issued
 *
 * Every emit* function here:
 *   - is a no-op (silently) when the operation has no owner_id -- there is
 *     no account to notify, and this is the overwhelming majority case for
 *     D2.6 harness / anonymous operations, which must stay entirely
 *     unaffected by D2.7B's existence.
 *   - NEVER throws. A webhook customer's endpoint being down, or even this
 *     module having a bug, must never break preflight/execution/
 *     finalization -- see webhookDelivery.ts's header.
 *   - relies on createWebhookEvent()'s (operation_id, type, dedupe_key)
 *     UNIQUE constraint for idempotency: calling emit* again for a
 *     transition that already produced an event is a safe no-op, and reuses
 *     the SAME event_id for any deliveries that don't already exist yet
 *     (Section 7).
 */
import { randomBytes } from 'node:crypto'
import {
  getCommerceOperation,
  createWebhookEvent,
  createWebhookDelivery,
  listActiveWebhookEndpointsForAccount,
  getExecutionBindingsForOperation,
  listCommerceObservations,
  type CommerceOperationRecord,
  type CommerceObservationRecord,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
} from './db.js'
import { deriveRecoveryStatus } from './operationHistory.js'
import { attemptDelivery } from './webhookDelivery.js'

function generateEventId(): string {
  return 'OCD-EVT-' + randomBytes(16).toString('base64url')
}
function generateDeliveryId(): string {
  return 'OCD-DLV-' + randomBytes(16).toString('base64url')
}

type WebhookEventType =
  | 'operation.preflight_completed'
  | 'operation.execution_updated'
  | 'operation.recovery_required'
  | 'operation.settlement_updated'
  | 'operation.receipt_produced'

/** Test seam covering every real dependency emitOperationEvent() touches -- same convention as executionBinding.ts's ExecutionBindingDependencies / webhookDelivery.ts's WebhookDeliveryDependencies. */
export interface EmitOperationEventDependencies {
  createWebhookEvent?: typeof createWebhookEvent
  createWebhookDelivery?: typeof createWebhookDelivery
  listActiveWebhookEndpointsForAccount?: typeof listActiveWebhookEndpointsForAccount
  attemptDelivery?: typeof attemptDelivery
}

/**
 * Core enqueue + best-effort immediate delivery. Exported for tests AND for
 * the specific emit* helpers below, which supply the correct dedupe_key/
 * data shape for each event type rather than leaving that to call sites.
 */
export async function emitOperationEvent(
  params: {
    accountId: string
    operationId: string
    type: WebhookEventType
    dedupeKey: string
    data: Record<string, unknown>
  },
  deps: EmitOperationEventDependencies = {}
): Promise<void> {
  const doCreateEvent = deps.createWebhookEvent ?? createWebhookEvent
  const doCreateDelivery = deps.createWebhookDelivery ?? createWebhookDelivery
  const doListEndpoints = deps.listActiveWebhookEndpointsForAccount ?? listActiveWebhookEndpointsForAccount
  const doAttemptDelivery = deps.attemptDelivery ?? attemptDelivery
  try {
    const { event } = await doCreateEvent({
      eventId: generateEventId(),
      accountId: params.accountId,
      operationId: params.operationId,
      type: params.type,
      dedupeKey: params.dedupeKey,
      data: params.data,
    })
    // `event` is the fresh row on first emission, or the PRE-EXISTING row on
    // a dedupe hit -- either way, deliveries are created (idempotently, see
    // createWebhookDelivery) against this SAME event_id, never a new one.
    const endpoints = await doListEndpoints(params.accountId)
    if (endpoints.length === 0) return

    const attempts: Array<{ delivery: WebhookDeliveryRecord; endpoint: WebhookEndpointRecord } | null> = await Promise.all(
      endpoints.map(async (endpoint) => {
        const { created, delivery } = await doCreateDelivery({ deliveryId: generateDeliveryId(), eventId: event.eventId, webhookId: endpoint.webhookId })
        if (!created) return null // this event/endpoint pair already has a delivery in flight or resolved -- nothing new to attempt inline
        return { delivery, endpoint }
      })
    )
    await Promise.all(
      attempts.map((attempt) => (attempt ? doAttemptDelivery(attempt.delivery, event, attempt.endpoint).catch(() => {}) : Promise.resolve()))
    )
  } catch (err) {
    console.error('D2.7B webhook event emission failed (non-fatal, operation flow is unaffected):', err)
  }
}

async function ownerOf(operationId: string): Promise<CommerceOperationRecord | null> {
  const op = await getCommerceOperation(operationId)
  return op && op.ownerId ? op : null
}

export async function emitPreflightCompleted(operationId: string, decisionStatus: string): Promise<void> {
  const op = await ownerOf(operationId).catch(() => null)
  if (!op || !op.ownerId) return
  await emitOperationEvent({
    accountId: op.ownerId,
    operationId,
    type: 'operation.preflight_completed',
    dedupeKey: decisionStatus,
    data: { decision: decisionStatus },
  })
}

const ATTENTION_EXECUTION_STATES = new Set(['manual_recovery_required', 'submission_ambiguous', 'outcome_unknown'])

export async function emitExecutionUpdated(
  operationId: string,
  executionState: CommerceOperationRecord['executionState'],
  executionRequestId: string,
  providerReference: string | null
): Promise<void> {
  const op = await ownerOf(operationId).catch(() => null)
  if (!op || !op.ownerId) return
  await emitOperationEvent({
    accountId: op.ownerId,
    operationId,
    type: 'operation.execution_updated',
    dedupeKey: executionState,
    data: { execution_state: executionState, execution_request_id: executionRequestId, provider_reference: providerReference },
  })

  if (ATTENTION_EXECUTION_STATES.has(executionState)) {
    try {
      const [bindings, observations] = await Promise.all([getExecutionBindingsForOperation(operationId), listCommerceObservations(operationId)])
      const recovery = deriveRecoveryStatus(op, bindings, observations)
      if (recovery.needsAttention) {
        await emitOperationEvent({
          accountId: op.ownerId,
          operationId,
          type: 'operation.recovery_required',
          dedupeKey: executionState,
          data: { summary: recovery.summary, safe_next_action: recovery.safeNextAction, may_already_have_paid: recovery.mayAlreadyHavePaid },
        })
      }
    } catch (err) {
      console.error('D2.7B recovery_required emission failed (non-fatal):', err)
    }
  }
}

export async function emitSettlementUpdated(operationId: string, observation: CommerceObservationRecord): Promise<void> {
  const op = await ownerOf(operationId).catch(() => null)
  if (!op || !op.ownerId) return
  await emitOperationEvent({
    accountId: op.ownerId,
    operationId,
    type: 'operation.settlement_updated',
    dedupeKey: observation.observationId,
    data: {
      observation_state: op.observationState,
      finality_state: observation.finalityState,
      transaction_hash: observation.transactionHash,
      binding_strength: observation.bindingStrength,
    },
  })
}

export async function emitReceiptProduced(operationId: string, receiptId: string, verificationState: string): Promise<void> {
  const op = await ownerOf(operationId).catch(() => null)
  if (!op || !op.ownerId) return
  await emitOperationEvent({
    accountId: op.ownerId,
    operationId,
    type: 'operation.receipt_produced',
    dedupeKey: receiptId,
    data: { receipt_id: receiptId, verification_state: verificationState },
  })
}
