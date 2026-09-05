/** D2.3 shared negative conformance vectors for src/receipts.ts's verifyReceiptEnvelope().
 *
 * Run with: npx tsx test/receiptConformance.ts
 *
 * These are the SAME scenarios exercised against the canonical package in
 * onchaindiligence/packages/agent-evidence/test/d23-conformance-vectors.test.mjs
 * (invalid enums, malformed present-but-garbage key timestamps, issued_at
 * outside the key window, a retired key missing valid_until, a real
 * historical-key shape). The two are meant to agree on every case -- that
 * agreement (not shared code, since this repo cannot yet depend on the
 * published package -- see D2.3 report) is the actual convergence target.
 *
 * Fully offline: no network, no real signing service, no real DB.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import {
  buildReceiptCore,
  finalizeReceiptCore,
  PUBLIC_ACTION_RECEIPT_ISSUER,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  receiptAttestationSigningInput,
  verifyReceiptEnvelope,
  type Receipt,
  type ReceiptCoreFields,
  type PublicActionReceiptEnvelope,
} from '../src/receipts.js'

function sampleCore(overrides: Partial<ReceiptCoreFields> = {}): ReceiptCoreFields {
  return buildReceiptCore({
    receipt_type: 'ACTION',
    issued_at: '2026-09-04T11:00:00.000Z',
    action: { kind: 'test', resource: null, network: null, asset: null, amount: null, sender: null, recipient: null },
    decision: { status: 'ALLOW', authorized: true, reasons: [] },
    execution: { provider: null, status: 'NOT_SUBMITTED', transaction_hash: null, submitted_at: null, confirmed_at: null },
    settlement: { status: 'NOT_APPLICABLE', detail: null },
    checks: [],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: [],
    ...overrides,
  })
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const KEY_ID = 'ed25519-TESTCONFORMANCEKEY'

function sign(
  receipt: Receipt,
  fields: { issuedAt: string; issuer?: string; purpose?: string; keyId?: string; includeHint?: boolean }
): PublicActionReceiptEnvelope {
  const issuer = fields.issuer ?? PUBLIC_ACTION_RECEIPT_ISSUER
  const purpose = fields.purpose ?? PUBLIC_ACTION_RECEIPT_PURPOSE
  const keyId = fields.keyId ?? KEY_ID
  const signingInput = receiptAttestationSigningInput(receipt, { issuer, purpose, issuedAt: fields.issuedAt, keyId })
  const signature = ed25519Sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return {
    schema: PUBLIC_ACTION_RECEIPT_SCHEMA,
    receipt,
    proof: {
      signed: true,
      schema_version: 'onchaindiligence.attestation.v2',
      issuer,
      purpose,
      issued_at: fields.issuedAt,
      key_id: keyId,
      algorithm: 'ed25519',
      canonicalization: 'RFC8785',
      ...(fields.includeHint ? { signing_input_hint: 'RFC 8785 canonical JSON over {...}' } : {}),
      signature,
    },
  }
}

function activeKey(overrides: Record<string, unknown> = {}) {
  return { key_id: KEY_ID, public_key_pem: publicKeyPem, status: 'active' as const, valid_from: '2026-09-01T00:00:00.000Z', valid_until: null, ...overrides }
}

// --- invalid enum values -----------------------------------------------

assert.throws(() => sampleCore({ decision: { status: 'MAYBE' as any, authorized: null, reasons: [] } }))
assert.throws(() => sampleCore({ execution: { provider: null, status: 'PENDING' as any, transaction_hash: null, submitted_at: null, confirmed_at: null } }))
assert.throws(() => sampleCore({ settlement: { status: 'SETTLED' as any, detail: null } }))
console.log('ok  invalid decision/execution/settlement enums rejected at construction time')

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z' })
  const tampered = { ...envelope, receipt: { ...envelope.receipt, decision: { ...envelope.receipt.decision, status: 'MAYBE' as any } } }
  const result = verifyReceiptEnvelope(tampered, [activeKey()])
  assert.equal(result.state, 'INVALID')
  assert.equal(result.code, 'schema-invalid')
}
console.log('ok  a schema-invalid enum smuggled into a signed envelope is INVALID, not VALID')

// --- signing_input_hint: optional field, present on some real receipts, absent on others ---

{
  const receipt = finalizeReceiptCore(sampleCore())
  const withHint = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z', includeHint: true })
  const withoutHint = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z', includeHint: false })
  assert.equal(verifyReceiptEnvelope(withHint, [activeKey()]).state, 'VALID')
  assert.equal(verifyReceiptEnvelope(withoutHint, [activeKey()]).state, 'VALID')
}
console.log('ok  proof.signing_input_hint is optional -- present or absent, both verify VALID (regression: this is real, present on live receipts minted after 2026-09-04)')

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z' })
  const withUnknownField = { ...envelope, proof: { ...envelope.proof, unexpected_field: 'x' } as any }
  const result = verifyReceiptEnvelope(withUnknownField, [activeKey()])
  assert.equal(result.state, 'INVALID')
  assert.equal(result.code, 'schema-invalid')
}
console.log('ok  a genuinely unrecognized extra proof field is still rejected -- the optional allowlist is exact, not wildcard')

// --- malformed key lifecycle timestamps: present but garbage, not missing ---

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z' })
  const result = verifyReceiptEnvelope(envelope, [activeKey({ valid_from: 'not-a-timestamp' })])
  assert.equal(result.state, 'UNVERIFIABLE', 'a malformed (non-null) valid_from must never silently pass as "no boundary"')
  assert.equal(result.code, 'key-valid-from-invalid')
}
console.log('ok  malformed (present, garbage) key valid_from -> UNVERIFIABLE, never VALID')

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-09-04T11:00:01.000Z' })
  const result = verifyReceiptEnvelope(envelope, [activeKey({ status: 'retired', valid_until: 'also-garbage' })])
  assert.equal(result.state, 'UNVERIFIABLE')
  assert.equal(result.code, 'key-valid-until-invalid')
}
console.log('ok  malformed (present, garbage) key valid_until -> UNVERIFIABLE, never treated as "no expiry"')

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: 'not-a-timestamp-either' })
  const result = verifyReceiptEnvelope(envelope, [activeKey()])
  assert.equal(result.state, 'INVALID', 'a malformed proof.issued_at is signer-controlled content, not key metadata -- INVALID, not UNVERIFIABLE')
  assert.equal(result.code, 'issued-at-invalid')
}
console.log('ok  malformed proof.issued_at -> INVALID (signer-controlled content), distinct from malformed key metadata -> UNVERIFIABLE')

// --- issued_at outside the key's validity window -------------------------

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-08-01T00:00:00.000Z' }) // before valid_from
  const result = verifyReceiptEnvelope(envelope, [activeKey()])
  assert.equal(result.state, 'INVALID')
  assert.equal(result.code, 'key-not-yet-valid')
}
{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-09-20T00:00:00.000Z' })
  const result = verifyReceiptEnvelope(envelope, [
    activeKey({ status: 'retired', valid_until: '2026-09-15T00:00:00.000Z' }),
  ], { now: new Date('2026-09-21T00:00:00.000Z') })
  assert.equal(result.state, 'INVALID')
  assert.equal(result.code, 'key-expired')
}
console.log('ok  proof.issued_at before valid_from / after valid_until -> INVALID (key-not-yet-valid / key-expired)')

// --- the real historical production key: valid_from null is tolerated, never invented ---

{
  const receipt = finalizeReceiptCore(sampleCore())
  const envelope = sign(receipt, { issuedAt: '2026-08-01T00:00:00.000Z' })
  // Same shape as the real historical onchaindiligence-mcp signing key record
  // (ed25519-D8wfc7civVNG05Ds): retired, valid_from unknown by design.
  const result = verifyReceiptEnvelope(envelope, [
    { key_id: KEY_ID, public_key_pem: publicKeyPem, status: 'retired' as const, valid_from: null, valid_until: '2026-09-03T19:50:00.000Z' },
  ])
  assert.equal(result.state, 'UNVERIFIABLE')
  assert.equal(result.code, 'key-valid-from-missing')
}
console.log('ok  a REAL retired-key-with-null-valid_from shape -> UNVERIFIABLE, never VALID, never invented')

console.log('\nAll D2.3 receipt conformance vectors passed.')
