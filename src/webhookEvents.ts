/**
 * webhookEvents.ts — D2.7B event emission (Sections 3/4/7).
 *
 * Six meaningful lifecycle events, each derived from EXISTING D2.4/D3.3 state
 * (never a parallel/invented lifecycle model):
 *   operation.preflight_completed  <- preflight_state -> 'completed'
 *   operation.execution_updated    <- execution_state transitions
 *   operation.recovery_required    <- deriveRecoveryStatus().needsAttention (D2.7A, reused as-is)
 *   operation.settlement_updated   <- a new commerce_observations row
 *   operation.receipt_produced     <- a Commerce receipt is issued
 *   operation.findings_updated     <- durable D3.3 reconciliation set
 *
 * D2.7B CORRECTION: this module used to attempt outbound HTTP delivery
 * inline, awaited from the same request that changed operation state --
 * meaning a slow/down customer endpoint could add up to the delivery
 * timeout to a real OCD preflight/execution/finalization HTTP request.
 * emitOperationEvent() now does ONLY the durable, DB-local part (create the
 * event row, create the delivery rows with next_attempt_at = now) and
 * returns -- no fetch() of any kind. The already-existing Vercel Cron
 * (every minute, see vercel.json) hitting POST/GET /internal/webhooks/deliver
 * is now the ONLY thing that ever performs an outbound webhook HTTP call
 * (webhookDelivery.ts's processDueDeliveries()/attemptDelivery(), both
 * unchanged). Worst case, a fresh event waits up to ~1 minute for its first
 * delivery attempt -- an explicitly accepted tradeoff for never blocking
 * the lifecycle request path on a customer's endpoint.
 *
 * Every emit* function here:
 *   - is a no-op (silently) when the operation has no owner_id -- there is
 *     no account to notify, and this is the overwhelming majority case for
 *     D2.6 harness / anonymous operations, which must stay entirely
 *     unaffected by D2.7B's existence.
 *   - NEVER throws. A bug in this module must never break preflight/
 *     execution/finalization -- see webhookDelivery.ts's header.
 *   - relies on createWebhookEvent()'s (operation_id, type, dedupe_key)
 *     UNIQUE constraint for idempotency: calling emit* again for a
 *     transition that already produced an event is a safe no-op, and reuses
 *     the SAME event_id for any deliveries that don't already exist yet
 *     (Section 7).
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  getCommerceOperation,
  createWebhookEvent,
  createWebhookDelivery,
  listActiveWebhookEndpointsForAccount,
  getExecutionBindingsForOperation,
  listCommerceObservations,
  getLifecycleStep,
  type CommerceOperationRecord,
  type CommerceObservationRecord,
} from './db.js'
import { deriveD33ReconciliationFindings, deriveRecoveryStatus } from './operationHistory.js'
import type { TaxonomyFinding } from './contradictionTaxonomy.js'

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
  | 'operation.findings_updated'

/** Test seam covering every real dependency emitOperationEvent() touches -- same convention as executionBinding.ts's ExecutionBindingDependencies / webhookDelivery.ts's WebhookDeliveryDependencies. */
export interface EmitOperationEventDependencies {
  createWebhookEvent?: typeof createWebhookEvent
  createWebhookDelivery?: typeof createWebhookDelivery
  listActiveWebhookEndpointsForAccount?: typeof listActiveWebhookEndpointsForAccount
}

export interface EmitFindingsUpdatedDependencies extends EmitOperationEventDependencies {
  getCommerceOperation?: typeof getCommerceOperation
  getExecutionBindingsForOperation?: typeof getExecutionBindingsForOperation
  listCommerceObservations?: typeof listCommerceObservations
  getLifecycleStep?: typeof getLifecycleStep
}

/**
 * Core enqueue-ONLY step. Exported for tests AND for the specific emit*
 * helpers below, which supply the correct dedupe_key/data shape for each
 * event type rather than leaving that to call sites. Performs no network
 * I/O of any kind -- see this file's header.
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

    // Enqueue only -- next_attempt_at defaults to now() (schema.sql), so the
    // cron's very next tick (within ~1 minute) picks these up. No fetch()
    // happens on this call path.
    await Promise.all(
      endpoints.map((endpoint) => doCreateDelivery({ deliveryId: generateDeliveryId(), eventId: event.eventId, webhookId: endpoint.webhookId }))
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

/**
 * Stable revision for the canonical D3.3 finding set only. It deliberately
 * excludes severity, prose, evidence references, and all legacy findings:
 * consumers are notified about a material reconciliation-class/code change,
 * then refetch the investigation for current detail.
 */
export function findingsRevision(findings: TaxonomyFinding[]): string {
  const canonical = findings.map((finding) => `${finding.finding_class}:${finding.code}`).sort().join('\n')
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * Enqueues a small, idempotent D3.3 findings change event after a durable
 * observation is available. This performs no network I/O and never makes a
 * lifecycle request fail if notification infrastructure is unavailable.
 */
export async function emitFindingsUpdated(operationId: string, deps: EmitFindingsUpdatedDependencies = {}): Promise<void> {
  try {
    const getOperation = deps.getCommerceOperation ?? getCommerceOperation
    const getBindings = deps.getExecutionBindingsForOperation ?? getExecutionBindingsForOperation
    const getObservations = deps.listCommerceObservations ?? listCommerceObservations
    const getPreflightStep = deps.getLifecycleStep ?? getLifecycleStep
    const op = await getOperation(operationId)
    if (!op?.ownerId) return

    const [bindings, observations, preflightStep] = await Promise.all([
      getBindings(operationId),
      getObservations(operationId),
      getPreflightStep(operationId, 'preflight'),
    ])
    const findingSet = deriveD33ReconciliationFindings(op, preflightStep, bindings, observations)
    if (!findingSet?.evaluated) return

    const contradictionCount = findingSet.findings.filter((finding) => finding.finding_class === 'CONTRADICTION').length
    const evidenceGapCount = findingSet.findings.filter((finding) => finding.finding_class === 'INSUFFICIENT_EVIDENCE').length
    const revision = findingsRevision(findingSet.findings)
    await emitOperationEvent({
      accountId: op.ownerId,
      operationId,
      type: 'operation.findings_updated',
      dedupeKey: revision,
      data: { revision, contradiction_count: contradictionCount, evidence_gap_count: evidenceGapCount },
    }, deps)
  } catch (err) {
    console.error('D3.4B-2 findings_updated emission failed (non-fatal, operation flow is unaffected):', err)
  }
}
