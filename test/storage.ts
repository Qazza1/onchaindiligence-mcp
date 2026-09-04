/** D2.2 integration tests for durable storage (db.ts) against a REAL Postgres database.
 *
 * Run with: npx tsx --env-file=.env.local test/storage.ts
 * (or any env providing DATABASE_URL — e.g. `vercel env pull .env.local` first)
 *
 * This is deliberately NOT faked: append-only conflict detection and atomic
 * capability consumption are exactly the behaviors that only mean something
 * against a real database engine. Every row this file writes is prefixed
 * with a run-unique test marker and deleted again at the end, success or
 * failure, so repeated runs never accumulate data and never collide with
 * real receipts.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  putReceipt,
  getPublicReceipt,
  getReceiptForFinalization,
  ReceiptConflictError,
  hashCapabilityToken,
  createFinalizationCapability,
  peekCapability,
  consumeCapabilityAndPublish,
} from '../src/db.js'
import { finalizeReceiptCore, PUBLIC_ACTION_RECEIPT_SCHEMA, type ReceiptCoreFields, type PublicActionReceiptEnvelope } from '../src/receipts.js'

if (!process.env.DATABASE_URL) {
  console.log('SKIP test/storage.ts: DATABASE_URL is not set (run with --env-file pointing at a real Postgres connection string)')
  process.exit(0)
}

const RUN_ID = randomUUID().slice(0, 8)
const createdReceiptIds: string[] = []
const createdCapabilityHashes: string[] = []

function fakeEnvelope(receiptType: 'PREFLIGHT' | 'COMMERCE', suffix: string, amount = '1.00'): PublicActionReceiptEnvelope {
  const core: ReceiptCoreFields = {
    receipt_type: receiptType,
    issued_at: '2026-09-04T00:00:00.000Z',
    action: {
      kind: 'PAYMENT',
      resource: null,
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount,
      sender: null,
      recipient: '0x000000000000000000000000000000000000dEaD',
    },
    decision: { status: 'ALLOW', authorized: true, reasons: ['test fixture'] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: 'test fixture' },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    // The suffix changes the content (and therefore the digest/id), which is
    // exactly what this file needs to mint distinct test receipt ids.
    limitations: [`storage-test-${RUN_ID}-${suffix}`],
  }
  const receipt = finalizeReceiptCore(core)
  createdReceiptIds.push(receipt.receipt_id)
  return { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof: { signed: true, note: 'test fixture, not independently verified by this file' } as any }
}

async function cleanup() {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL!)
  for (const hash of createdCapabilityHashes) {
    await sql.query('DELETE FROM finalization_capabilities WHERE capability_hash = $1', [hash])
  }
  for (const id of createdReceiptIds) {
    await sql.query('DELETE FROM receipts WHERE receipt_id = $1', [id])
  }
}

try {
  // --- fresh insert + exact lookup ---------------------------------------
  const envelopeA = fakeEnvelope('PREFLIGHT', 'fresh')
  await putReceipt(envelopeA, { isPublic: true })
  const resolved = await getPublicReceipt(envelopeA.receipt.receipt_id)
  assert.deepEqual(resolved, envelopeA)
  console.log('ok  durable receipt insert + exact public lookup')

  // --- idempotent identical duplicate write -------------------------------
  await assert.doesNotReject(() => putReceipt(envelopeA, { isPublic: true }))
  console.log('ok  identical duplicate write is idempotent (no error, no second row)')

  // --- conflicting write to the same id fails closed ----------------------
  // putReceipt()'s own contract is purely id+digest based (same id + same
  // digest -> idempotent; same id + different digest -> conflict) — the
  // digest/content/id self-consistency check is verifyReceiptEnvelope's job,
  // performed by every real caller BEFORE putReceipt is ever reached. So the
  // conflict this simulates is exactly what putReceipt must catch on its
  // own: a write attempt reusing an existing id with a different digest.
  const conflicting: PublicActionReceiptEnvelope = {
    ...envelopeA,
    receipt: {
      ...envelopeA.receipt,
      decision: { status: 'BLOCK', authorized: false, reasons: ['different content, same id'] },
      receipt_digest: envelopeA.receipt.receipt_digest.replace(/.$/, envelopeA.receipt.receipt_digest.endsWith('A') ? 'B' : 'A'),
    },
  }
  await assert.rejects(() => putReceipt(conflicting, { isPublic: true }), ReceiptConflictError)
  console.log('ok  conflicting write to the same receipt_id fails closed (ReceiptConflictError), never overwrites')

  // --- private receipt resolves internally but not via the public path ---
  const privateEnvelope = fakeEnvelope('PREFLIGHT', 'private')
  await putReceipt(privateEnvelope, { isPublic: false })
  assert.equal(await getPublicReceipt(privateEnvelope.receipt.receipt_id), null, 'a private receipt must not resolve via the public path')
  const internal = await getReceiptForFinalization(privateEnvelope.receipt.receipt_id)
  assert.deepEqual(internal?.envelope, privateEnvelope)
  assert.equal(internal?.isPublic, false)
  console.log('ok  private receipt: 404-equivalent (null) via the public path, but internally readable for finalization')

  // --- unknown id and private id are indistinguishable via the public path ---
  assert.equal(await getPublicReceipt('OCD-RCP-0000-0000-0000-0000'), null)
  console.log('ok  unknown receipt id resolves to null, same as a private one, via the public path')

  // --- capability lifecycle -----------------------------------------------
  const preflightForCap = fakeEnvelope('PREFLIGHT', 'cap-preflight')
  await putReceipt(preflightForCap, { isPublic: false })

  const rawToken = 'test-token-' + RUN_ID + '-' + randomUUID()
  const capabilityHash = hashCapabilityToken(rawToken)
  createdCapabilityHashes.push(capabilityHash)
  assert.equal(capabilityHash.length, 64, 'sha256 hex digest is 64 characters')
  assert.notEqual(capabilityHash, rawToken)

  await createFinalizationCapability({
    capabilityHash,
    preflightReceiptId: preflightForCap.receipt.receipt_id,
    preflightReceiptDigest: preflightForCap.receipt.receipt_digest,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publishCommerce: true,
  })
  const peeked = await peekCapability(capabilityHash)
  assert.ok(peeked)
  assert.equal(peeked!.preflightReceiptId, preflightForCap.receipt.receipt_id)
  assert.equal(peeked!.usedAt, null)
  assert.equal(peeked!.publishCommerce, true)
  console.log('ok  capability created and looked up by hash; only the hash is queryable, never a raw token column')

  // --- atomic consume + publish -------------------------------------------
  const commerceEnvelope = fakeEnvelope('COMMERCE', 'cap-commerce')
  const txHash = '0x' + 'ab'.repeat(32)
  const outcome1 = await consumeCapabilityAndPublish({
    capabilityHash,
    transactionHash: txHash,
    commerceEnvelope,
    isPublic: true,
  })
  assert.deepEqual(outcome1, { kind: 'consumed' })
  const afterConsume = await peekCapability(capabilityHash)
  assert.ok(afterConsume!.usedAt)
  assert.equal(afterConsume!.consumedTransactionHash, txHash)
  assert.equal(afterConsume!.commerceReceiptId, commerceEnvelope.receipt.receipt_id)
  const publishedCommerce = await getPublicReceipt(commerceEnvelope.receipt.receipt_id)
  assert.deepEqual(publishedCommerce, commerceEnvelope)
  console.log('ok  consumeCapabilityAndPublish atomically marks the capability used AND publishes the Commerce Receipt')

  // --- retry with the SAME transaction hash -> idempotent replay ---------
  const outcome2 = await consumeCapabilityAndPublish({
    capabilityHash,
    transactionHash: txHash,
    commerceEnvelope,
    isPublic: true,
  })
  assert.deepEqual(outcome2, { kind: 'replay', commerceReceiptId: commerceEnvelope.receipt.receipt_id })
  console.log('ok  retrying the same capability + same transaction hash is an idempotent replay, not a new write')

  // --- a DIFFERENT transaction hash after consumption is rejected --------
  const anotherCommerce = fakeEnvelope('COMMERCE', 'cap-commerce-different-tx')
  const outcome3 = await consumeCapabilityAndPublish({
    capabilityHash,
    transactionHash: '0x' + 'cd'.repeat(32),
    commerceEnvelope: anotherCommerce,
    isPublic: true,
  })
  assert.deepEqual(outcome3, { kind: 'consumed-different-tx' })
  assert.equal(await getPublicReceipt(anotherCommerce.receipt.receipt_id), null, 'the rejected alternate receipt must never have been written')
  console.log('ok  the same consumed capability with a DIFFERENT transaction hash is rejected, and nothing is written')

  // --- expired capability is rejected, never silently replaced -----------
  const expiredToken = 'expired-token-' + RUN_ID
  const expiredHash = hashCapabilityToken(expiredToken)
  createdCapabilityHashes.push(expiredHash)
  const preflightForExpired = fakeEnvelope('PREFLIGHT', 'cap-expired')
  await putReceipt(preflightForExpired, { isPublic: false })
  await createFinalizationCapability({
    capabilityHash: expiredHash,
    preflightReceiptId: preflightForExpired.receipt.receipt_id,
    preflightReceiptDigest: preflightForExpired.receipt.receipt_digest,
    expiresAt: new Date(Date.now() - 60_000).toISOString(), // already expired
    publishCommerce: false,
  })
  const expiredOutcome = await consumeCapabilityAndPublish({
    capabilityHash: expiredHash,
    transactionHash: txHash,
    commerceEnvelope: fakeEnvelope('COMMERCE', 'cap-expired-commerce'),
    isPublic: false,
  })
  assert.deepEqual(expiredOutcome, { kind: 'expired' })
  console.log('ok  an expired capability is rejected by the atomic consume step, not silently replaced')

  // --- unknown capability hash ---------------------------------------------
  const unknownOutcome = await consumeCapabilityAndPublish({
    capabilityHash: hashCapabilityToken('never-existed-' + RUN_ID),
    transactionHash: txHash,
    commerceEnvelope: fakeEnvelope('COMMERCE', 'cap-unknown'),
    isPublic: false,
  })
  assert.deepEqual(unknownOutcome, { kind: 'not-found' })
  console.log('ok  an unknown capability hash is reported not-found')

  console.log('\nAll D2.2 durable storage integration tests passed.')
} finally {
  await cleanup()
}
