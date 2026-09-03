import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { BundledReceiptStore } from '../src/receiptStore.js'
import { REFERENCE_RECEIPT } from '../src/receipts/referenceReceiptData.js'
import { mountReceipts } from '../src/receiptsRoute.js'
import {
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  computeReceiptDigest,
  formatReceiptId,
  verifyReceiptEnvelope,
  type PublicActionReceiptEnvelope,
} from '../src/receipts.js'

const unsignedEnvelope: PublicActionReceiptEnvelope = {
  schema: PUBLIC_ACTION_RECEIPT_SCHEMA,
  receipt: REFERENCE_RECEIPT,
  proof: { signed: false },
}

assert.equal(REFERENCE_RECEIPT.receipt_id, 'OCD-RCP-EMG6-6KR4-PQSG-MZPQ')
assert.equal(REFERENCE_RECEIPT.receipt_digest, 'sha256:dSBjTwS18wp-15gRHOmTW_2zUKOaXjH9pil1hJcNclY')
assert.equal(REFERENCE_RECEIPT.receipt_type, 'ACTION')
assert.equal(REFERENCE_RECEIPT.decision.status, 'REQUIRE_APPROVAL')
assert.equal(REFERENCE_RECEIPT.decision.authorized, false)
assert.equal(REFERENCE_RECEIPT.execution.status, 'NOT_SUBMITTED')
assert.equal(REFERENCE_RECEIPT.settlement.status, 'NOT_APPLICABLE')
assert.equal(REFERENCE_RECEIPT.execution.transaction_hash, null)
assert.equal(REFERENCE_RECEIPT.action.sender, null)
assert.equal(REFERENCE_RECEIPT.links.agent_evidence_bundle_digest, 'sha256:b3Y51kb7-JfTCzA-MbVBHAiLdo43xlJLpAbT4eed6rw')
assert.equal(computeReceiptDigest((({ receipt_id, receipt_digest, ...core }) => core)(REFERENCE_RECEIPT)), REFERENCE_RECEIPT.receipt_digest)
assert.equal(formatReceiptId(REFERENCE_RECEIPT.receipt_digest), REFERENCE_RECEIPT.receipt_id)

const invalidProof = verifyReceiptEnvelope(unsignedEnvelope, [])
assert.equal(invalidProof.state, 'INVALID')
assert.equal(verifyReceiptEnvelope({ ...unsignedEnvelope, receipt: { ...REFERENCE_RECEIPT, receipt_id: 'OCD-RCP-0000-0000-0000-0000' } }, []).code, 'id-mismatch')
assert.equal(verifyReceiptEnvelope({ ...unsignedEnvelope, receipt: { ...REFERENCE_RECEIPT, receipt_digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }, []).code, 'digest-mismatch')

const app = new Hono()
mountReceipts(app, new BundledReceiptStore([unsignedEnvelope]))
const known = await app.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`, { headers: { Origin: 'https://onchaindiligence.com' } })
assert.equal(known.status, 200)
assert.equal(known.headers.get('access-control-allow-origin'), 'https://onchaindiligence.com')
assert.deepEqual(await known.json(), unsignedEnvelope)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts/not-a-receipt')).status, 400)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts/OCD-RCP-0000-0000-0000-0000')).status, 404)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts')).status, 404)
assert.equal((await app.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`, { headers: { Origin: 'https://attacker.example' } })).headers.get('access-control-allow-origin'), null)

console.log('receipt resolver and reference data checks passed')
