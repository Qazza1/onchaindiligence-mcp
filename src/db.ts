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
