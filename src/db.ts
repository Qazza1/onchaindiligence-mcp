/**
 * db.ts — durable storage for D2.2 (receipts + finalization capabilities).
 *
 * Backing store: Postgres via the Vercel-provisioned Neon integration
 * (DATABASE_URL). Chosen because: (a) it was the smallest durable option
 * actually available to this deployment — this project had ZERO marketplace
 * integrations before D2.2 (confirmed via `vercel integration installations`
 * before adding one), so Vercel's native Postgres/Neon add-on was the
 * lowest-friction "smallest suitable durable store" rather than a bespoke
 * KV service; (b) it survives redeploys/instances, unlike process memory or
 * the bundled TS source D2.0A used; (c) two small tables are enough — no
 * ORM, no framework. See db/schema.sql for the full schema.
 *
 * The Neon serverless driver (`@neondatabase/serverless`) is used two ways:
 *   - `sql` (HTTP, one round trip per query) for simple, independent reads
 *     and writes where cross-statement atomicity isn't required.
 *   - `Pool` (WebSocket, real session) for the ONE place that genuinely
 *     needs an interactive transaction with conditional branching in
 *     application code: consuming a finalization capability atomically with
 *     inserting its Commerce Receipt. See consumeCapabilityAndPublish().
 */
import { createHash } from 'node:crypto'
import { neon, Pool } from '@neondatabase/serverless'
import type { PublicActionReceiptEnvelope } from './receipts.js'

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not configured')
  return url
}

let sqlClient: ReturnType<typeof neon> | null = null
function sql() {
  if (!sqlClient) sqlClient = neon(databaseUrl())
  return sqlClient
}

export class ReceiptConflictError extends Error {
  constructor(receiptId: string) {
    super(`receipt ${receiptId} already exists with different content`)
    this.name = 'ReceiptConflictError'
  }
}

export interface StoredReceipt {
  envelope: PublicActionReceiptEnvelope
  isPublic: boolean
}

/**
 * Idempotent append-only insert. Same receipt_id + identical envelope ->
 * silent success (idempotent replay). Same receipt_id + a DIFFERENT
 * envelope/digest -> fails closed with ReceiptConflictError. Never UPDATEs
 * a receipt into different content.
 */
export async function putReceipt(
  envelope: PublicActionReceiptEnvelope,
  options: { isPublic: boolean }
): Promise<void> {
  const receiptId = envelope.receipt.receipt_id
  const digest = envelope.receipt.receipt_digest
  const rows = (await sql().query(
    `INSERT INTO receipts (receipt_id, receipt_digest, receipt_type, envelope_json, is_public)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (receipt_id) DO NOTHING
     RETURNING receipt_id`,
    [receiptId, digest, envelope.receipt.receipt_type, JSON.stringify(envelope), options.isPublic]
  )) as unknown as Array<{ receipt_id: string }>

  if (rows.length > 0) return // fresh insert

  // Already present — verify it's the identical envelope (idempotent
  // replay), not a conflicting write to the same id.
  const existing = await getReceiptByIdInternal(receiptId)
  if (!existing || existing.envelope.receipt.receipt_digest !== digest) {
    throw new ReceiptConflictError(receiptId)
  }
}

async function getReceiptByIdInternal(receiptId: string): Promise<StoredReceipt | null> {
  const rows = (await sql().query('SELECT envelope_json, is_public FROM receipts WHERE receipt_id = $1', [
    receiptId,
  ])) as unknown as Array<{ envelope_json: PublicActionReceiptEnvelope; is_public: boolean }>
  const row = rows[0]
  if (!row) return null
  return { envelope: row.envelope_json, isPublic: row.is_public }
}

/** Resolver-facing lookup: returns null for both "unknown" and "private" — the two must be externally indistinguishable. */
export async function getPublicReceipt(receiptId: string): Promise<PublicActionReceiptEnvelope | null> {
  const stored = await getReceiptByIdInternal(receiptId)
  if (!stored || !stored.isPublic) return null
  return stored.envelope
}

/** Internal-only lookup (finalization needs the bound PREFLIGHT receipt regardless of its publication choice). */
export async function getReceiptForFinalization(receiptId: string): Promise<StoredReceipt | null> {
  return getReceiptByIdInternal(receiptId)
}

export function hashCapabilityToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export async function createFinalizationCapability(params: {
  capabilityHash: string
  preflightReceiptId: string
  preflightReceiptDigest: string
  expiresAt: string
  publishCommerce: boolean
}): Promise<void> {
  await sql().query(
    `INSERT INTO finalization_capabilities
       (capability_hash, preflight_receipt_id, preflight_receipt_digest, expires_at, publish_commerce)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.capabilityHash, params.preflightReceiptId, params.preflightReceiptDigest, params.expiresAt, params.publishCommerce]
  )
}

export interface CapabilityRecord {
  capabilityHash: string
  preflightReceiptId: string
  preflightReceiptDigest: string
  expiresAt: string
  usedAt: string | null
  consumedTransactionHash: string | null
  commerceReceiptId: string | null
  publishCommerce: boolean
}

function mapCapabilityRow(row: any): CapabilityRecord {
  return {
    capabilityHash: row.capability_hash,
    preflightReceiptId: row.preflight_receipt_id,
    preflightReceiptDigest: row.preflight_receipt_digest,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    usedAt: row.used_at ? (row.used_at instanceof Date ? row.used_at.toISOString() : row.used_at) : null,
    consumedTransactionHash: row.consumed_transaction_hash ?? null,
    commerceReceiptId: row.commerce_receipt_id ?? null,
    publishCommerce: row.publish_commerce === true,
  }
}

/** Fast, non-locking pre-check — used to fail early before doing any RPC/signing work. Never mutates. */
export async function peekCapability(capabilityHash: string): Promise<CapabilityRecord | null> {
  const rows = (await sql().query('SELECT * FROM finalization_capabilities WHERE capability_hash = $1', [
    capabilityHash,
  ])) as unknown as any[]
  const row = rows[0]
  return row ? mapCapabilityRow(row) : null
}

/**
 * D2.2B2: used only by scripts/reconcile-commerce-receipt.ts to cross-check
 * that the capability actually consumed for a stuck Commerce Receipt really
 * points back at the same preflight/transaction/receipt id before any
 * reconciliation proceeds. Read-only.
 */
export async function getCapabilityByCommerceReceiptId(commerceReceiptId: string): Promise<CapabilityRecord | null> {
  const rows = (await sql().query('SELECT * FROM finalization_capabilities WHERE commerce_receipt_id = $1', [
    commerceReceiptId,
  ])) as unknown as any[]
  const row = rows[0]
  return row ? mapCapabilityRow(row) : null
}

export type ConsumeOutcome =
  | { kind: 'consumed' }
  | { kind: 'replay'; commerceReceiptId: string }
  | { kind: 'not-found' }
  | { kind: 'expired' }
  | { kind: 'consumed-different-tx' }

let pool: InstanceType<typeof Pool> | null = null
function getPool() {
  if (!pool) pool = new Pool({ connectionString: databaseUrl() })
  return pool
}

/**
 * Atomically consumes a finalization capability and publishes its Commerce
 * Receipt in ONE database transaction — the two either both happen or
 * neither does. Called only AFTER settlement has been independently
 * observed and the Commerce Receipt has been built, signed, and
 * independently re-verified VALID (see finalizeRoute.ts): everything that
 * can fail (RPC calls, signing) happens BEFORE this function is ever
 * called, so a crash or network failure during that earlier work leaves the
 * capability untouched and safe to retry.
 *
 * Idempotency inside the transaction:
 *   - unused, unexpired -> mark used, insert the receipt -> 'consumed'
 *   - already used with the SAME transaction hash -> 'replay' (caller
 *     returns the existing Commerce Receipt, no new write)
 *   - already used with a DIFFERENT transaction hash -> 'consumed-different-tx'
 *   - not found / expired -> reported as such, no write
 */
export async function consumeCapabilityAndPublish(params: {
  capabilityHash: string
  transactionHash: string
  commerceEnvelope: PublicActionReceiptEnvelope
  isPublic: boolean
}): Promise<ConsumeOutcome> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const capRes = await client.query(
      'SELECT * FROM finalization_capabilities WHERE capability_hash = $1 FOR UPDATE',
      [params.capabilityHash]
    )
    const cap = capRes.rows[0]
    if (!cap) {
      await client.query('ROLLBACK')
      return { kind: 'not-found' }
    }
    if (cap.used_at) {
      await client.query('ROLLBACK')
      if (cap.consumed_transaction_hash === params.transactionHash && cap.commerce_receipt_id) {
        return { kind: 'replay', commerceReceiptId: cap.commerce_receipt_id }
      }
      return { kind: 'consumed-different-tx' }
    }
    if (new Date(cap.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK')
      return { kind: 'expired' }
    }

    const receiptId = params.commerceEnvelope.receipt.receipt_id
    const digest = params.commerceEnvelope.receipt.receipt_digest
    await client.query(
      `INSERT INTO receipts (receipt_id, receipt_digest, receipt_type, envelope_json, is_public)
       VALUES ($1, $2, 'COMMERCE', $3::jsonb, $4)`,
      [receiptId, digest, JSON.stringify(params.commerceEnvelope), params.isPublic]
    )
    await client.query(
      `UPDATE finalization_capabilities
       SET used_at = now(), consumed_transaction_hash = $2, commerce_receipt_id = $3
       WHERE capability_hash = $1`,
      [params.capabilityHash, params.transactionHash, receiptId]
    )
    await client.query('COMMIT')
    return { kind: 'consumed' }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------
// D2.2B2 — no-payment reconciliation of a Commerce Receipt whose original
// chain observation could not obtain a definitive result (see
// scripts/reconcile-commerce-receipt.ts). Never touches
// finalization_capabilities: reconciliation is not a capability action, it
// only appends a NEW, separate immutable Commerce Receipt plus one
// idempotency row linking it back to the prior receipt it re-observes.
// ---------------------------------------------------------------------

/** Read-only idempotency check — used by the reconciliation script's dry run and as the fast pre-check before the real write. */
export async function getReconciliationForPriorReceipt(priorReceiptId: string): Promise<{ reconciledReceiptId: string } | null> {
  const rows = (await sql().query(
    'SELECT reconciled_receipt_id FROM receipt_reconciliations WHERE prior_receipt_id = $1',
    [priorReceiptId]
  )) as unknown as Array<{ reconciled_receipt_id: string }>
  const row = rows[0]
  return row ? { reconciledReceiptId: row.reconciled_receipt_id } : null
}

export type ReconciliationOutcome =
  | { kind: 'created' }
  | { kind: 'already-reconciled'; reconciledReceiptId: string }

/**
 * Atomically inserts the new reconciled Commerce Receipt AND the
 * idempotency row in one transaction — never one without the other, and
 * never a second reconciliation for the same prior receipt (the SELECT ...
 * FOR UPDATE below serializes concurrent runs; the table's PRIMARY KEY on
 * prior_receipt_id is the backstop if that race is somehow still hit).
 * Never UPDATEs or overwrites either the prior receipt or a
 * previously-reconciled one.
 */
export async function recordReconciliation(params: {
  priorReceiptId: string
  reconciledEnvelope: PublicActionReceiptEnvelope
  isPublic: boolean
}): Promise<ReconciliationOutcome> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      'SELECT reconciled_receipt_id FROM receipt_reconciliations WHERE prior_receipt_id = $1 FOR UPDATE',
      [params.priorReceiptId]
    )
    if (existing.rows[0]) {
      await client.query('ROLLBACK')
      return { kind: 'already-reconciled', reconciledReceiptId: existing.rows[0].reconciled_receipt_id }
    }

    const receiptId = params.reconciledEnvelope.receipt.receipt_id
    const digest = params.reconciledEnvelope.receipt.receipt_digest
    await client.query(
      `INSERT INTO receipts (receipt_id, receipt_digest, receipt_type, envelope_json, is_public)
       VALUES ($1, $2, 'COMMERCE', $3::jsonb, $4)`,
      [receiptId, digest, JSON.stringify(params.reconciledEnvelope), params.isPublic]
    )
    await client.query(
      `INSERT INTO receipt_reconciliations (prior_receipt_id, reconciled_receipt_id) VALUES ($1, $2)`,
      [params.priorReceiptId, receiptId]
    )
    await client.query('COMMIT')
    return { kind: 'created' }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------
// D2.4 — durable operations, step idempotency, execution bindings, and
// append-only chain observations. See db/schema.sql's D2.4 section for the
// table shapes and the reasoning behind each. Every function below is a
// thin, direct mapping onto one table — the interesting logic (claim
// semantics, binding-strength derivation, etc.) lives in the modules that
// call these, not here, mirroring how putReceipt/consumeCapabilityAndPublish
// above keep the SQL itself boring.
// ---------------------------------------------------------------------

export interface CommerceOperationRecord {
  operationId: string
  recoveryCredentialHash: string
  preflightState: 'not_started' | 'in_progress' | 'completed'
  executionState: 'not_submitted' | 'prepared' | 'submission_ambiguous' | 'submitted' | 'outcome_unknown' | 'transaction_known' | 'manual_recovery_required'
  observationState: 'none' | 'pending' | 'confirmed' | 'contradicted'
  receiptState: 'none' | 'preflight_only' | 'commerce_issued'
  preflightReceiptId: string | null
  /** D2.7A: which operator (if any) this operation is privately visible to. Null/undefined for anonymous/pre-D2.7A operations -- see db/schema.sql's ALTER TABLE comment. Optional so existing fixtures/tests built before D2.7A don't need updating just to satisfy this type. */
  ownerId?: string | null
  createdAt: string
}

function mapOperationRow(row: any): CommerceOperationRecord {
  return {
    operationId: row.operation_id,
    recoveryCredentialHash: row.recovery_credential_hash,
    preflightState: row.preflight_state,
    executionState: row.execution_state,
    observationState: row.observation_state,
    receiptState: row.receipt_state,
    preflightReceiptId: row.preflight_receipt_id ?? null,
    ownerId: row.owner_id ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

export async function createCommerceOperation(params: { operationId: string; recoveryCredentialHash: string; ownerId?: string | null }): Promise<void> {
  await sql().query(
    `INSERT INTO commerce_operations (operation_id, recovery_credential_hash, owner_id) VALUES ($1, $2, $3)`,
    [params.operationId, params.recoveryCredentialHash, params.ownerId ?? null]
  )
}

export async function getCommerceOperation(operationId: string): Promise<CommerceOperationRecord | null> {
  const rows = (await sql().query('SELECT * FROM commerce_operations WHERE operation_id = $1', [operationId])) as unknown as any[]
  const row = rows[0]
  return row ? mapOperationRow(row) : null
}

export async function updateCommerceOperationState(
  operationId: string,
  fields: Partial<{
    preflightState: CommerceOperationRecord['preflightState']
    executionState: CommerceOperationRecord['executionState']
    observationState: CommerceOperationRecord['observationState']
    receiptState: CommerceOperationRecord['receiptState']
    preflightReceiptId: string
  }>
): Promise<void> {
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  if (fields.preflightState !== undefined) { sets.push(`preflight_state = $${i++}`); values.push(fields.preflightState) }
  if (fields.executionState !== undefined) { sets.push(`execution_state = $${i++}`); values.push(fields.executionState) }
  if (fields.observationState !== undefined) { sets.push(`observation_state = $${i++}`); values.push(fields.observationState) }
  if (fields.receiptState !== undefined) { sets.push(`receipt_state = $${i++}`); values.push(fields.receiptState) }
  if (fields.preflightReceiptId !== undefined) { sets.push(`preflight_receipt_id = $${i++}`); values.push(fields.preflightReceiptId) }
  if (sets.length === 0) return
  sets.push(`updated_at = now()`)
  values.push(operationId)
  await sql().query(`UPDATE commerce_operations SET ${sets.join(', ')} WHERE operation_id = $${i}`, values)
}

// --- lifecycle_steps -----------------------------------------------------

export interface LifecycleStepRow {
  operationId: string
  stepKey: string
  inputDigest: string
  status: 'claimed' | 'paid' | 'completed'
  frozenInput: unknown
  capabilityToken: string | null
  capabilityExpiresAt: string | null
  resultJson: unknown | null
}

function mapStepRow(row: any): LifecycleStepRow {
  return {
    operationId: row.operation_id,
    stepKey: row.step_key,
    inputDigest: row.input_digest,
    status: row.status,
    frozenInput: row.frozen_input_json,
    capabilityToken: row.capability_token ?? null,
    capabilityExpiresAt: row.capability_expires_at
      ? row.capability_expires_at instanceof Date
        ? row.capability_expires_at.toISOString()
        : row.capability_expires_at
      : null,
    resultJson: row.result_json ?? null,
  }
}

/** Atomic claim: returns the row that now exists for (operationId, stepKey) -- freshly inserted if `claimed` is true, pre-existing otherwise. Never a partial/racy read. */
export async function claimLifecycleStep(params: {
  operationId: string
  stepKey: string
  inputDigest: string
  frozenInput: unknown
}): Promise<{ claimed: boolean; row: LifecycleStepRow }> {
  const inserted = (await sql().query(
    `INSERT INTO lifecycle_steps (operation_id, step_key, input_digest, status, frozen_input_json)
     VALUES ($1, $2, $3, 'claimed', $4::jsonb)
     ON CONFLICT (operation_id, step_key) DO NOTHING
     RETURNING *`,
    [params.operationId, params.stepKey, params.inputDigest, JSON.stringify(params.frozenInput)]
  )) as unknown as any[]
  if (inserted[0]) return { claimed: true, row: mapStepRow(inserted[0]) }

  const existing = (await sql().query(
    'SELECT * FROM lifecycle_steps WHERE operation_id = $1 AND step_key = $2',
    [params.operationId, params.stepKey]
  )) as unknown as any[]
  if (!existing[0]) throw new Error('lifecycle step disappeared between insert and read -- this should never happen')
  return { claimed: false, row: mapStepRow(existing[0]) }
}

export async function markLifecycleStepPaid(operationId: string, stepKey: string): Promise<void> {
  await sql().query(
    `UPDATE lifecycle_steps SET status = 'paid', updated_at = now() WHERE operation_id = $1 AND step_key = $2 AND status = 'claimed'`,
    [operationId, stepKey]
  )
}

export async function setLifecycleStepCapability(
  operationId: string,
  stepKey: string,
  capabilityToken: string,
  capabilityExpiresAt: string
): Promise<void> {
  await sql().query(
    `UPDATE lifecycle_steps SET capability_token = $3, capability_expires_at = $4, updated_at = now()
     WHERE operation_id = $1 AND step_key = $2 AND capability_token IS NULL`,
    [operationId, stepKey, capabilityToken, capabilityExpiresAt]
  )
}

export async function completeLifecycleStep(operationId: string, stepKey: string, resultJson: unknown): Promise<void> {
  await sql().query(
    `UPDATE lifecycle_steps SET status = 'completed', result_json = $3::jsonb, updated_at = now()
     WHERE operation_id = $1 AND step_key = $2`,
    [operationId, stepKey, JSON.stringify(resultJson)]
  )
}

export async function getLifecycleStep(operationId: string, stepKey: string): Promise<LifecycleStepRow | null> {
  const rows = (await sql().query(
    'SELECT * FROM lifecycle_steps WHERE operation_id = $1 AND step_key = $2',
    [operationId, stepKey]
  )) as unknown as any[]
  return rows[0] ? mapStepRow(rows[0]) : null
}

// --- execution_bindings ----------------------------------------------------

export interface ExecutionBindingRecord {
  executionRequestId: string
  operationId: string
  clientSubmissionKey: string
  executorIdentity: string
  executorVersion: string
  recoveryCapabilityClass: 'provider-idempotent' | 'stable-payment-identity' | 'none'
  frozenPreflightReceiptId: string
  frozenPreflightReceiptDigest: string
  expectedPayer: string | null
  providerReference: string | null
  submissionState: string
}

function mapBindingRow(row: any): ExecutionBindingRecord {
  return {
    executionRequestId: row.execution_request_id,
    operationId: row.operation_id,
    clientSubmissionKey: row.client_submission_key,
    executorIdentity: row.executor_identity,
    executorVersion: row.executor_version,
    recoveryCapabilityClass: row.recovery_capability_class,
    frozenPreflightReceiptId: row.frozen_preflight_receipt_id,
    frozenPreflightReceiptDigest: row.frozen_preflight_receipt_digest,
    expectedPayer: row.expected_payer ?? null,
    providerReference: row.provider_reference ?? null,
    submissionState: row.submission_state,
  }
}

/** Idempotent by (operationId, clientSubmissionKey): a stale retrying worker can never mint a second binding for what it believes is the same submission attempt. */
export async function createExecutionBinding(params: {
  executionRequestId: string
  operationId: string
  clientSubmissionKey: string
  executorIdentity: string
  executorVersion: string
  recoveryCapabilityClass: ExecutionBindingRecord['recoveryCapabilityClass']
  frozenPreflightReceiptId: string
  frozenPreflightReceiptDigest: string
  expectedPayer: string | null
  providerReference: string | null
}): Promise<{ created: boolean; binding: ExecutionBindingRecord }> {
  const inserted = (await sql().query(
    `INSERT INTO execution_bindings
       (execution_request_id, operation_id, client_submission_key, executor_identity, executor_version,
        recovery_capability_class, frozen_preflight_receipt_id, frozen_preflight_receipt_digest, expected_payer, provider_reference)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (operation_id, client_submission_key) DO NOTHING
     RETURNING *`,
    [
      params.executionRequestId,
      params.operationId,
      params.clientSubmissionKey,
      params.executorIdentity,
      params.executorVersion,
      params.recoveryCapabilityClass,
      params.frozenPreflightReceiptId,
      params.frozenPreflightReceiptDigest,
      params.expectedPayer,
      params.providerReference,
    ]
  )) as unknown as any[]
  if (inserted[0]) return { created: true, binding: mapBindingRow(inserted[0]) }

  const existing = (await sql().query(
    'SELECT * FROM execution_bindings WHERE operation_id = $1 AND client_submission_key = $2',
    [params.operationId, params.clientSubmissionKey]
  )) as unknown as any[]
  if (!existing[0]) throw new Error('execution binding disappeared between insert and read -- this should never happen')
  return { created: false, binding: mapBindingRow(existing[0]) }
}

export async function updateExecutionBindingSubmissionState(executionRequestId: string, submissionState: string): Promise<void> {
  await sql().query(`UPDATE execution_bindings SET submission_state = $2, updated_at = now() WHERE execution_request_id = $1`, [
    executionRequestId,
    submissionState,
  ])
}

/**
 * D2.6 correction (Section 4): a durable, one-way `provider_reference`
 * attach for a binding created BEFORE the provider request identity was
 * known (e.g. PayBox gateway mode, whose useService() call now happens in
 * submit() -- AFTER the execution binding already exists -- not prepare()).
 *
 * Atomic at the SQL level: the row is updated only when its
 * `provider_reference` is currently NULL or already equals the exact same
 * value being written (idempotent retry) -- a single conditional UPDATE,
 * no separate read-then-write, so two concurrent callers can never race
 * each other into silently overwriting one reference with another.
 */
export class ProviderReferenceConflictError extends Error {
  constructor(executionRequestId: string, existing: string, attempted: string) {
    super(`execution binding ${executionRequestId} already has provider_reference "${existing}" -- refusing to overwrite it with "${attempted}"`)
    this.name = 'ProviderReferenceConflictError'
  }
}

export async function updateExecutionBindingProviderReference(executionRequestId: string, providerReference: string): Promise<ExecutionBindingRecord> {
  const updated = (await sql().query(
    `UPDATE execution_bindings
       SET provider_reference = $2, updated_at = now()
     WHERE execution_request_id = $1
       AND (provider_reference IS NULL OR provider_reference = $2)
     RETURNING *`,
    [executionRequestId, providerReference]
  )) as unknown as any[]
  if (updated[0]) return mapBindingRow(updated[0])

  const existing = (await sql().query('SELECT * FROM execution_bindings WHERE execution_request_id = $1', [executionRequestId])) as unknown as any[]
  if (!existing[0]) throw new Error(`execution binding ${executionRequestId} not found`)
  throw new ProviderReferenceConflictError(executionRequestId, existing[0].provider_reference, providerReference)
}

export async function getExecutionBinding(executionRequestId: string): Promise<ExecutionBindingRecord | null> {
  const rows = (await sql().query('SELECT * FROM execution_bindings WHERE execution_request_id = $1', [
    executionRequestId,
  ])) as unknown as any[]
  return rows[0] ? mapBindingRow(rows[0]) : null
}

/**
 * D2.6 correction (Astra final-review, remaining bypass): read-only lookup
 * of EVERY durable execution binding for an operation, so the server can
 * determine from DURABLE STATE -- never from a caller-supplied
 * execution_request_id being present/absent, or from caller-supplied
 * execution_provider -- whether a PayBox v1-gateway binding already exists
 * for this operation before finalization is allowed to proceed. Read-only,
 * no ordering guarantee needed beyond "all rows for this operation_id".
 */
export async function listExecutionBindingsForOperation(operationId: string): Promise<ExecutionBindingRecord[]> {
  const rows = (await sql().query('SELECT * FROM execution_bindings WHERE operation_id = $1', [operationId])) as unknown as any[]
  return rows.map(mapBindingRow)
}

// --- commerce_observations -------------------------------------------------

export interface CommerceObservationRecord {
  observationId: string
  operationId: string
  network: string
  blockNumber: string
  blockHash: string
  transactionHash: string
  logIndex: number
  observedPayer: string | null
  observedRecipient: string | null
  observedAmountAtomic: string | null
  tokenContract: string
  paymentAuthorizer: string | null
  paymentAuthorizationNonce: string | null
  finalityPolicy: string
  finalityState: string
  chainHeadUsed: unknown | null
  bindingStrength: 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED'
  bundleDigest: string | null
}

function mapObservationRow(row: any): CommerceObservationRecord {
  return {
    observationId: row.observation_id,
    operationId: row.operation_id,
    network: row.network,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    observedPayer: row.observed_payer ?? null,
    observedRecipient: row.observed_recipient ?? null,
    observedAmountAtomic: row.observed_amount_atomic ?? null,
    tokenContract: row.token_contract,
    paymentAuthorizer: row.payment_authorizer ?? null,
    paymentAuthorizationNonce: row.payment_authorization_nonce ?? null,
    finalityPolicy: row.finality_policy,
    finalityState: row.finality_state,
    chainHeadUsed: row.chain_head_used_json ?? null,
    bindingStrength: row.binding_strength,
    bundleDigest: row.bundle_digest ?? null,
  }
}

/**
 * Append-only by construction: the natural key (network, block_hash,
 * transaction_hash, log_index) means the SAME exact chain event can never be
 * recorded twice, while a genuinely different event (reorg re-inclusion, a
 * later corrective re-observation, a second payment attempt) always inserts
 * a new row rather than colliding with or overwriting a prior one.
 */
export async function recordCommerceObservation(
  params: Omit<CommerceObservationRecord, 'observationId'> & { observationId: string }
): Promise<{ created: boolean; observation: CommerceObservationRecord }> {
  const inserted = (await sql().query(
    `INSERT INTO commerce_observations
       (observation_id, operation_id, network, block_number, block_hash, transaction_hash, log_index,
        observed_payer, observed_recipient, observed_amount_atomic, token_contract,
        payment_authorizer, payment_authorization_nonce, finality_policy, finality_state,
        chain_head_used_json, binding_strength, bundle_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
     ON CONFLICT (network, block_hash, transaction_hash, log_index) DO NOTHING
     RETURNING *`,
    [
      params.observationId,
      params.operationId,
      params.network,
      params.blockNumber,
      params.blockHash,
      params.transactionHash,
      params.logIndex,
      params.observedPayer,
      params.observedRecipient,
      params.observedAmountAtomic,
      params.tokenContract,
      params.paymentAuthorizer,
      params.paymentAuthorizationNonce,
      params.finalityPolicy,
      params.finalityState,
      params.chainHeadUsed === null ? null : JSON.stringify(params.chainHeadUsed),
      params.bindingStrength,
      params.bundleDigest,
    ]
  )) as unknown as any[]
  if (inserted[0]) return { created: true, observation: mapObservationRow(inserted[0]) }

  const existing = (await sql().query(
    'SELECT * FROM commerce_observations WHERE network = $1 AND block_hash = $2 AND transaction_hash = $3 AND log_index = $4',
    [params.network, params.blockHash, params.transactionHash, params.logIndex]
  )) as unknown as any[]
  if (!existing[0]) throw new Error('commerce observation disappeared between insert and read -- this should never happen')
  return { created: false, observation: mapObservationRow(existing[0]) }
}

export async function listCommerceObservations(operationId: string): Promise<CommerceObservationRecord[]> {
  const rows = (await sql().query('SELECT * FROM commerce_observations WHERE operation_id = $1 ORDER BY observed_at ASC', [
    operationId,
  ])) as unknown as any[]
  return rows.map(mapObservationRow)
}

/** All execution bindings ever created for an operation (normally zero or one; more than one only if a caller genuinely attempted more than one distinct client_submission_key). Ordered oldest-first, same convention as listCommerceObservations. */
export async function getExecutionBindingsForOperation(operationId: string): Promise<ExecutionBindingRecord[]> {
  const rows = (await sql().query('SELECT * FROM execution_bindings WHERE operation_id = $1 ORDER BY created_at ASC', [
    operationId,
  ])) as unknown as any[]
  return rows.map(mapBindingRow)
}

// ---------------------------------------------------------------------
// D2.7A — accounts (private operation history + recovery center). NOT the
// same "operator" as the operator/ directory (the D2.2B manual payment
// console UI) -- see db/schema.sql's "D2.7A" section and src/accounts.ts
// for the identity model this backs. Kept deliberately as small as
// operation.ts's own create/get pair.
// ---------------------------------------------------------------------

export interface AccountRecord {
  accountId: string
  apiKeyHash: string
  createdAt: string
}

function mapAccountRow(row: any): AccountRecord {
  return {
    accountId: row.account_id,
    apiKeyHash: row.api_key_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

export async function createAccount(params: { accountId: string; apiKeyHash: string }): Promise<void> {
  await sql().query(`INSERT INTO accounts (account_id, api_key_hash) VALUES ($1, $2)`, [params.accountId, params.apiKeyHash])
}

export async function getAccountByApiKeyHash(apiKeyHash: string): Promise<AccountRecord | null> {
  const rows = (await sql().query('SELECT * FROM accounts WHERE api_key_hash = $1', [apiKeyHash])) as unknown as any[]
  return rows[0] ? mapAccountRow(rows[0]) : null
}

/**
 * Bounded, cursor-paginated: newest first. `before` (an ISO timestamp from a
 * previous page's last row) excludes everything at or after it, so passing
 * the last row's createdAt reliably continues the listing even when several
 * operations share the same created_at to the second. Deliberately no
 * filtering beyond ownership (Section 2: "do not build complex filtering yet").
 */
export async function listCommerceOperationsForOwner(
  ownerId: string,
  options: { limit?: number; before?: string } = {}
): Promise<CommerceOperationRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const rows = options.before
    ? ((await sql().query(
        'SELECT * FROM commerce_operations WHERE owner_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT $3',
        [ownerId, options.before, limit]
      )) as unknown as any[])
    : ((await sql().query('SELECT * FROM commerce_operations WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2', [
        ownerId,
        limit,
      ])) as unknown as any[])
  return rows.map(mapOperationRow)
}

/**
 * Finds the Commerce receipt produced for an operation, via the ONE column
 * that already links them: the operation's own preflight_receipt_id, which
 * the finalization_capabilities row for that preflight also carries (see
 * lifecycleFinalizeRoute.ts). No new column on commerce_operations needed.
 */
export async function getCommerceReceiptIdForPreflightReceipt(preflightReceiptId: string): Promise<string | null> {
  const rows = (await sql().query(
    'SELECT commerce_receipt_id FROM finalization_capabilities WHERE preflight_receipt_id = $1 AND commerce_receipt_id IS NOT NULL LIMIT 1',
    [preflightReceiptId]
  )) as unknown as any[]
  return rows[0]?.commerce_receipt_id ?? null
}

// ---------------------------------------------------------------------
// D2.7B — account-scoped outbound webhooks. See db/schema.sql's "D2.7B"
// section for the table shapes and idempotency/retry discipline.
// ---------------------------------------------------------------------

export interface WebhookEndpointRecord {
  webhookId: string
  accountId: string
  url: string
  signingSecret: string
  status: 'active' | 'disabled'
  createdAt: string
}

function mapWebhookEndpointRow(row: any): WebhookEndpointRecord {
  return {
    webhookId: row.webhook_id,
    accountId: row.account_id,
    url: row.url,
    signingSecret: row.signing_secret,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

export async function createWebhookEndpoint(params: { webhookId: string; accountId: string; url: string; signingSecret: string }): Promise<WebhookEndpointRecord> {
  const rows = (await sql().query(
    `INSERT INTO webhook_endpoints (webhook_id, account_id, url, signing_secret) VALUES ($1, $2, $3, $4) RETURNING *`,
    [params.webhookId, params.accountId, params.url, params.signingSecret]
  )) as unknown as any[]
  return mapWebhookEndpointRow(rows[0])
}

export async function countActiveWebhookEndpointsForAccount(accountId: string): Promise<number> {
  const rows = (await sql().query(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ])) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

export async function listWebhookEndpointsForAccount(accountId: string): Promise<WebhookEndpointRecord[]> {
  const rows = (await sql().query('SELECT * FROM webhook_endpoints WHERE account_id = $1 ORDER BY created_at DESC', [
    accountId,
  ])) as unknown as any[]
  return rows.map(mapWebhookEndpointRow)
}

/** Active endpoints only -- what an event fan-out actually delivers to. */
export async function listActiveWebhookEndpointsForAccount(accountId: string): Promise<WebhookEndpointRecord[]> {
  const rows = (await sql().query(`SELECT * FROM webhook_endpoints WHERE account_id = $1 AND status = 'active'`, [
    accountId,
  ])) as unknown as any[]
  return rows.map(mapWebhookEndpointRow)
}

export async function getWebhookEndpoint(webhookId: string): Promise<WebhookEndpointRecord | null> {
  const rows = (await sql().query('SELECT * FROM webhook_endpoints WHERE webhook_id = $1', [webhookId])) as unknown as any[]
  return rows[0] ? mapWebhookEndpointRow(rows[0]) : null
}

/** Ownership-checked: deletes only if the endpoint belongs to accountId. Returns whether a row was actually deleted. Cascades to webhook_deliveries (schema ON DELETE CASCADE). */
export async function deleteWebhookEndpointForAccount(webhookId: string, accountId: string): Promise<boolean> {
  const rows = (await sql().query('DELETE FROM webhook_endpoints WHERE webhook_id = $1 AND account_id = $2 RETURNING webhook_id', [
    webhookId,
    accountId,
  ])) as unknown as any[]
  return rows.length > 0
}

export interface WebhookEventRecord {
  eventId: string
  accountId: string
  operationId: string
  type: string
  dedupeKey: string
  data: unknown
  createdAt: string
}

function mapWebhookEventRow(row: any): WebhookEventRecord {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    operationId: row.operation_id,
    type: row.type,
    dedupeKey: row.dedupe_key,
    data: row.data_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

/**
 * Idempotent by (operation_id, type, dedupe_key): a retried lifecycle
 * transition that re-runs the same enqueue call never creates a second
 * event. Returns `created: false` (with the EXISTING event) on a dedupe
 * hit -- the caller uses this to skip creating deliveries a second time.
 */
export async function createWebhookEvent(params: {
  eventId: string
  accountId: string
  operationId: string
  type: string
  dedupeKey: string
  data: unknown
}): Promise<{ created: boolean; event: WebhookEventRecord }> {
  const inserted = (await sql().query(
    `INSERT INTO webhook_events (event_id, account_id, operation_id, type, dedupe_key, data_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (operation_id, type, dedupe_key) DO NOTHING
     RETURNING *`,
    [params.eventId, params.accountId, params.operationId, params.type, params.dedupeKey, JSON.stringify(params.data)]
  )) as unknown as any[]
  if (inserted[0]) return { created: true, event: mapWebhookEventRow(inserted[0]) }

  const existing = (await sql().query('SELECT * FROM webhook_events WHERE operation_id = $1 AND type = $2 AND dedupe_key = $3', [
    params.operationId,
    params.type,
    params.dedupeKey,
  ])) as unknown as any[]
  if (!existing[0]) throw new Error('webhook event disappeared between insert and read -- this should never happen')
  return { created: false, event: mapWebhookEventRow(existing[0]) }
}

export interface WebhookDeliveryRecord {
  deliveryId: string
  eventId: string
  webhookId: string
  status: 'pending' | 'delivered' | 'failed'
  attemptCount: number
  nextAttemptAt: string
  lastHttpStatus: number | null
  lastError: string | null
  createdAt: string
  deliveredAt: string | null
}

function mapWebhookDeliveryRow(row: any): WebhookDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    webhookId: row.webhook_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at instanceof Date ? row.next_attempt_at.toISOString() : row.next_attempt_at,
    lastHttpStatus: row.last_http_status ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    deliveredAt: row.delivered_at ? (row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at) : null,
  }
}

/** Idempotent by (event_id, webhook_id) -- re-enqueueing for an event/endpoint pair that already has a delivery row is a no-op, never a duplicate. */
export async function createWebhookDelivery(params: { deliveryId: string; eventId: string; webhookId: string }): Promise<{ created: boolean; delivery: WebhookDeliveryRecord }> {
  const inserted = (await sql().query(
    `INSERT INTO webhook_deliveries (delivery_id, event_id, webhook_id) VALUES ($1, $2, $3) ON CONFLICT (event_id, webhook_id) DO NOTHING RETURNING *`,
    [params.deliveryId, params.eventId, params.webhookId]
  )) as unknown as any[]
  if (inserted[0]) return { created: true, delivery: mapWebhookDeliveryRow(inserted[0]) }
  const existing = (await sql().query('SELECT * FROM webhook_deliveries WHERE event_id = $1 AND webhook_id = $2', [
    params.eventId,
    params.webhookId,
  ])) as unknown as any[]
  return { created: false, delivery: mapWebhookDeliveryRow(existing[0]) }
}

export async function markWebhookDeliveryDelivered(deliveryId: string, httpStatus: number): Promise<void> {
  await sql().query(
    `UPDATE webhook_deliveries SET status = 'delivered', attempt_count = attempt_count + 1, last_http_status = $2, last_error = NULL, delivered_at = now(), updated_at = now() WHERE delivery_id = $1`,
    [deliveryId, httpStatus]
  )
}

export async function markWebhookDeliveryRetry(deliveryId: string, nextAttemptAt: string, httpStatus: number | null, error: string | null): Promise<void> {
  await sql().query(
    `UPDATE webhook_deliveries SET status = 'pending', attempt_count = attempt_count + 1, next_attempt_at = $2, last_http_status = $3, last_error = $4, updated_at = now() WHERE delivery_id = $1`,
    [deliveryId, nextAttemptAt, httpStatus, error]
  )
}

export async function markWebhookDeliveryFailed(deliveryId: string, httpStatus: number | null, error: string | null): Promise<void> {
  await sql().query(
    `UPDATE webhook_deliveries SET status = 'failed', attempt_count = attempt_count + 1, last_http_status = $2, last_error = $3, updated_at = now() WHERE delivery_id = $1`,
    [deliveryId, httpStatus, error]
  )
}

/** Due for (re)attempt: status='pending' and next_attempt_at has arrived. Bounded -- the caller (the delivery worker) decides the batch size. */
export async function listDueWebhookDeliveries(limit: number): Promise<WebhookDeliveryRecord[]> {
  const rows = (await sql().query(
    `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at ASC LIMIT $1`,
    [limit]
  )) as unknown as any[]
  return rows.map(mapWebhookDeliveryRow)
}

export async function getWebhookEventById(eventId: string): Promise<WebhookEventRecord | null> {
  const rows = (await sql().query('SELECT * FROM webhook_events WHERE event_id = $1', [eventId])) as unknown as any[]
  return rows[0] ? mapWebhookEventRow(rows[0]) : null
}

/** Ownership-checked (via the webhook_id -> account_id join implied by the caller already having resolved the endpoint) -- bounded recent history for GET /me/webhooks/:id/deliveries. */
export async function listDeliveriesForWebhook(webhookId: string, limit: number): Promise<Array<WebhookDeliveryRecord & { eventType: string; operationId: string }>> {
  const rows = (await sql().query(
    `SELECT d.*, e.type AS event_type, e.operation_id AS operation_id
     FROM webhook_deliveries d JOIN webhook_events e ON e.event_id = d.event_id
     WHERE d.webhook_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
    [webhookId, limit]
  )) as unknown as any[]
  return rows.map((row) => ({ ...mapWebhookDeliveryRow(row), eventType: row.event_type, operationId: row.operation_id }))
}
