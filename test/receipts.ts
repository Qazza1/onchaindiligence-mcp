import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { BundledReceiptStore } from '../src/receiptStore.js'
import { REFERENCE_RECEIPT } from '../src/receipts/referenceReceiptData.js'
import { REFERENCE_RECEIPTS } from '../src/receipts/referenceReceipts.js'
import { mountReceipts } from '../src/receiptsRoute.js'
import {
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  PUBLIC_ACTION_RECEIPT_ISSUER,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  buildReceiptCore,
  finalizeReceiptCore,
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
assert.equal(verifyReceiptEnvelope(signedEnvelope, [{ ...newSignerRegistry[0], valid_from: '2026-09-03T20:56:25.000Z' }]).code, 'key-not-yet-valid')

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

// --- D2.2: durable store resolution order, and fail-open to bundled ------

// A structurally sound (schema-conformant, digest/id self-consistent) but
// not cryptographically-signed fixture -- the resolver's integrity check
// never verifies signatures (no registry access, by design; see
// receiptsRoute.ts), so this is a legitimate "durable store returned THIS
// distinct receipt" marker, unlike a bare `{ durable: true }` object, which
// (correctly, post-D2.3) now fails structural integrity and would 500.
const durableFixtureReceipt = finalizeReceiptCore(
  buildReceiptCore({
    receipt_type: 'ACTION',
    issued_at: '2026-09-04T00:00:00.000Z',
    action: { kind: 'test-durable-fixture', resource: null, network: null, asset: null, amount: null, sender: null, recipient: null },
    decision: { status: 'ALLOW', authorized: true, reasons: [] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: null },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
  })
)
const durableFixtureEnvelope: PublicActionReceiptEnvelope = {
  schema: PUBLIC_ACTION_RECEIPT_SCHEMA,
  receipt: durableFixtureReceipt,
  proof: {
    signed: true,
    schema_version: 'onchaindiligence.attestation.v2',
    issuer: PUBLIC_ACTION_RECEIPT_ISSUER,
    purpose: PUBLIC_ACTION_RECEIPT_PURPOSE,
    issued_at: '2026-09-04T00:00:01.000Z',
    key_id: 'ed25519-P2jIwhCn-Af6pTz4',
    algorithm: 'ed25519',
    canonicalization: 'RFC8785',
    signature: 'x'.repeat(86), // shape-valid, not cryptographically verified by the resolver's structural check
  },
}

{
  const durableApp = new Hono()
  let durableCalls = 0
  mountReceipts(durableApp, new BundledReceiptStore([signedEnvelope]), async (id) => {
    durableCalls++
    return id === 'OCD-RCP-TEST-DVRB-1E00-0001' ? durableFixtureEnvelope : null
  })

  const durableHit = await durableApp.request('https://mcp.onchaindiligence.com/receipts/OCD-RCP-TEST-DVRB-1E00-0001')
  assert.equal(durableHit.status, 200)
  assert.deepEqual(await durableHit.json(), durableFixtureEnvelope)
  assert.equal(durableCalls, 1)

  // Not in the durable store -> falls through to the bundled reference store.
  const bundledFallback = await durableApp.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`)
  assert.equal(bundledFallback.status, 200)
  assert.deepEqual(await bundledFallback.json(), signedEnvelope)
  console.log('ok  durable store resolves first; bundled reference store is a fallback, not bypassed')
}

{
  // The durable store being completely unreachable must not break the
  // resolver -- the bundled reference receipt must keep resolving.
  const brokenApp = new Hono()
  mountReceipts(brokenApp, new BundledReceiptStore([signedEnvelope]), async () => {
    throw new Error('DATABASE_URL is not configured')
  })
  const res = await brokenApp.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), signedEnvelope)
  console.log('ok  durable store failure falls back to the bundled store rather than failing the request')
}

// --- D2.3 (Task 4): structural integrity gate distinguishes corrupt stored
// data (reject) from a merely unreachable trust source (never gates serving) ---

{
  // A corrupt/tampered stored row (digest no longer matches content) must
  // never be served as if it were a trustworthy receipt -- but this is a
  // LOCAL, network-free check: it must not be confused with "the key
  // registry is unreachable", which correctly does NOT block serving.
  const corruptEnvelope: PublicActionReceiptEnvelope = {
    ...durableFixtureEnvelope,
    receipt: { ...durableFixtureEnvelope.receipt, decision: { ...durableFixtureEnvelope.receipt.decision, status: 'BLOCK' } },
  }
  const corruptApp = new Hono()
  mountReceipts(corruptApp, new BundledReceiptStore([signedEnvelope]), async (id) =>
    id === 'OCD-RCP-TEST-CRPT-0000-0001' ? corruptEnvelope : null
  )
  const res = await corruptApp.request('https://mcp.onchaindiligence.com/receipts/OCD-RCP-TEST-CRPT-0000-0001')
  assert.equal(res.status, 500, 'a stored envelope whose digest no longer matches its content must never be served as trustworthy')
  const body = (await res.json()) as any
  assert.ok(!JSON.stringify(body).includes('BLOCK'), 'the corrupt stored content itself must never leak into the error response')
  console.log('ok  a corrupt stored envelope (digest mismatch) is rejected (500), not served')
}

{
  // The known-good reference receipt must still resolve even though this
  // check never contacts a key registry or network at all -- confirms the
  // integrity gate cannot be affected by trust-source reachability, since
  // it makes no such call in the first place.
  const app = new Hono()
  mountReceipts(app, new BundledReceiptStore([signedEnvelope]))
  const res = await app.request(`https://mcp.onchaindiligence.com/receipts/${REFERENCE_RECEIPT.receipt_id}`)
  assert.equal(res.status, 200)
  console.log('ok  the structural integrity gate never depends on key-registry/network reachability')
}

console.log('\nAll D2.2 resolver tests passed.')
