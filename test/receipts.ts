import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { BundledReceiptStore } from '../src/receiptStore.js'
import { REFERENCE_RECEIPT } from '../src/receipts/referenceReceiptData.js'
import { REFERENCE_RECEIPTS } from '../src/receipts/referenceReceipts.js'
import { mountReceipts } from '../src/receiptsRoute.js'
import {
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  computeReceiptDigest,
  formatReceiptId,
  verifyReceiptEnvelope,
  type PublicActionReceiptEnvelope,
} from '../src/receipts.js'

const signedEnvelope = REFERENCE_RECEIPTS[0] as PublicActionReceiptEnvelope
const newSignerRegistry = [{
  key_id: 'ed25519-P2jIwhCn-Af6pTz4',
  public_key_pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEARCxQg8J+f2d5qcrJmCoeLjpJIDeKbE6dbB1mXHTsn04=\n-----END PUBLIC KEY-----\n',
  status: 'active' as const,
  valid_from: '2026-09-03T19:50:00.000Z',
  valid_until: null,
}]

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

assert.equal(verifyReceiptEnvelope(signedEnvelope, newSignerRegistry).state, 'VALID')
assert.equal(verifyReceiptEnvelope(signedEnvelope, []).state, 'UNVERIFIABLE')
assert.equal(verifyReceiptEnvelope({ ...signedEnvelope, receipt: { ...signedEnvelope.receipt, receipt_id: 'OCD-RCP-0000-0000-0000-0000' } }, newSignerRegistry).code, 'id-mismatch')
assert.equal(verifyReceiptEnvelope({ ...signedEnvelope, receipt: { ...signedEnvelope.receipt, decision: { ...signedEnvelope.receipt.decision, status: 'ALLOW' } } }, newSignerRegistry).code, 'digest-mismatch')
assert.equal(verifyReceiptEnvelope({ ...signedEnvelope, receipt: { ...signedEnvelope.receipt, decision: { ...signedEnvelope.receipt.decision, authorized: true } } }, newSignerRegistry).code, 'digest-mismatch')
assert.equal(verifyReceiptEnvelope({ ...signedEnvelope, proof: { ...signedEnvelope.proof, signature: `${signedEnvelope.proof.signature?.slice(0, -1)}A` } }, newSignerRegistry).code, 'signature-invalid')
assert.equal(verifyReceiptEnvelope(signedEnvelope, [{ ...newSignerRegistry[0], valid_from: '2026-09-03T20:56:25.000Z' }]).code, 'key-window-violation')

const app = new Hono()
mountReceipts(app, new BundledReceiptStore([signedEnvelope]))
const known = await app.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`, { headers: { Origin: 'https://onchaindiligence.com' } })
assert.equal(known.status, 200)
assert.equal(known.headers.get('access-control-allow-origin'), 'https://onchaindiligence.com')
assert.deepEqual(await known.json(), signedEnvelope)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts/not-a-receipt')).status, 400)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts/OCD-RCP-0000-0000-0000-0000')).status, 404)
assert.equal((await app.request('https://mcp.onchaindiligence.com/receipts')).status, 404)
assert.equal((await app.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`, { headers: { Origin: 'https://attacker.example' } })).headers.get('access-control-allow-origin'), null)

console.log('receipt resolver and reference data checks passed')
