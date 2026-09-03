/**
 * receipts.ts — minimal, ported copy of the Public Action Receipt v1
 * protocol logic (onchaindiligence.public-action-receipt.v1).
 *
 * SOURCE OF TRUTH: the `onchaindiligence` repo's `packages/agent-evidence`
 * package (src/receipts.ts, src/receiptId.ts) and
 * `docs/PUBLIC_ACTION_RECEIPT_V1.md`. That package is not published to npm,
 * so this file ports only what this deployment needs — building a receipt
 * core, computing its digest/id, and serving/verifying finalized receipts —
 * without pulling in the full Agent Evidence bundle/DSSE machinery this
 * service never touches. Keep this in sync with the canonical package by
 * hand; do not let the two algorithms drift.
 *
 * This module never signs anything and holds no private key. Signing goes
 * through the existing attest() -> POST /attest network call in attest.ts,
 * using the one key held by the HTTP API.
 */
import { createHash, verify as ed25519Verify, createPublicKey } from 'node:crypto'

// ---------------------------------------------------------------------
// RFC 8785-style canonical JSON + content digest.
// Identical algorithm to onchaindilige/src/canonicalJson.ts and
// onchaindiligence/packages/agent-evidence/src/canonical.ts (sorted-key
// recursive JSON.stringify) — confirmed interoperable with both.
// ---------------------------------------------------------------------
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new TypeError(`value of type ${typeof value} is not valid JSON`)
}

export function contentId(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('base64url')}`
}

/**
 * The exact bytes an `onchaindiligence.attestation.v2` signer must sign over
 * a finalized receipt — identical construction to what `verifyReceiptEnvelope`
 * recomputes below. This module never signs anything itself (see file
 * header); this export exists so tests can produce a genuinely-shaped fake
 * signature (a fresh local keypair + a caller-supplied registry) without
 * duplicating the canonicalizer.
 */
export function receiptAttestationSigningInput(
  receipt: unknown,
  fields: { issuer: string; purpose: string; issuedAt: string; keyId: string }
): string {
  return canonicalizeJson({
    schema_version: 'onchaindiligence.attestation.v2',
    issuer: fields.issuer,
    purpose: fields.purpose,
    data: receipt,
    issued_at: fields.issuedAt,
    key_id: fields.keyId,
  })
}

// ---------------------------------------------------------------------
// Crockford Base32 receipt id codec — ported verbatim from
// packages/agent-evidence/src/receiptId.ts. See that file / the spec doc
// for the full rationale (deterministic, non-sequential, locator only).
// ---------------------------------------------------------------------
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DECODE_MAP: ReadonlyMap<string, number> = new Map([
  ...[...CROCKFORD_ALPHABET].map((char, index) => [char, index] as const),
  ['O', 0], ['I', 1], ['L', 1],
])
const DIGEST_BYTES_USED = 10
const CHARS_PER_GROUP = 4
const GROUP_COUNT = 4
const PREFIX = 'OCD-RCP-'
const RECEIPT_DIGEST_PATTERN = /^sha256:([A-Za-z0-9_-]{43})$/
const RECEIPT_ID_PATTERN = new RegExp(
  `^OCD-RCP-([0-9A-Z]{${CHARS_PER_GROUP}}-){${GROUP_COUNT - 1}}[0-9A-Z]{${CHARS_PER_GROUP}}$`
)

function digestToBytes(receiptDigest: string): Buffer {
  const match = RECEIPT_DIGEST_PATTERN.exec(receiptDigest)
  if (!match) throw new Error(`receipt digest is not a valid sha256 content id: ${receiptDigest}`)
  return Buffer.from(match[1] as string, 'base64url')
}

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += CROCKFORD_ALPHABET[(value >> bits) & 0x1f]
    }
  }
  if (bits > 0) output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f]
  return output
}

export function formatReceiptId(receiptDigest: string): string {
  const bytes = digestToBytes(receiptDigest).subarray(0, DIGEST_BYTES_USED)
  if (bytes.length !== DIGEST_BYTES_USED) throw new Error('receipt digest is too short to derive a receipt id')
  const encoded = encodeCrockford(bytes)
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += CHARS_PER_GROUP) groups.push(encoded.slice(i, i + CHARS_PER_GROUP))
  return PREFIX + groups.join('-')
}

export function isValidReceiptIdFormat(receiptId: string): boolean {
  return RECEIPT_ID_PATTERN.test(receiptId.toUpperCase())
}

export function normalizeReceiptId(input: string): string | null {
  const upper = input.trim().toUpperCase()
  if (!isValidReceiptIdFormat(upper)) return null
  const body = upper.slice(PREFIX.length).replace(/-/g, '')
  let canonicalBody = ''
  for (const char of body) {
    const decoded = DECODE_MAP.get(char)
    if (decoded === undefined) return null
    canonicalBody += CROCKFORD_ALPHABET[decoded]
  }
  const groups: string[] = []
  for (let i = 0; i < canonicalBody.length; i += CHARS_PER_GROUP) groups.push(canonicalBody.slice(i, i + CHARS_PER_GROUP))
  return PREFIX + groups.join('-')
}

// ---------------------------------------------------------------------
// Receipt core / envelope shape — mirrors
// packages/agent-evidence/src/receipts.ts exactly.
// ---------------------------------------------------------------------
export const PUBLIC_ACTION_RECEIPT_SCHEMA = 'onchaindiligence.public-action-receipt.v1'
export const PUBLIC_ACTION_RECEIPT_PURPOSE = 'public-action-receipt'
export const PUBLIC_ACTION_RECEIPT_ISSUER = 'https://api.onchaindiligence.com'

export type ReceiptType = 'PREFLIGHT' | 'COMMERCE' | 'ACTION'
export type DecisionStatus = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'UNKNOWN'
export type ExecutionStatus = 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
export type SettlementStatus = 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNVERIFIED' | 'NOT_APPLICABLE'
export type CheckResult = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_CHECKED'

export interface ReceiptAction {
  kind: string
  resource: string | null
  network: string | null
  asset: string | null
  amount: string | null
  sender: string | null
  recipient: string | null
}
export interface ReceiptDecision { status: DecisionStatus; authorized: boolean | null; reasons: string[] }
export interface ReceiptExecution {
  provider: string | null
  status: ExecutionStatus
  transaction_hash: string | null
  submitted_at: string | null
  confirmed_at: string | null
}
export interface ReceiptSettlement { status: SettlementStatus; detail: string | null }
export interface ReceiptCheck { id: string; result: CheckResult; summary: string; evidence_digest: string | null }
export interface ReceiptLinks { agent_evidence_bundle_digest: string | null; preflight_receipt_id: string | null }

export interface ReceiptCoreFields {
  receipt_type: ReceiptType
  issued_at: string
  action: ReceiptAction
  decision: ReceiptDecision
  execution: ReceiptExecution
  settlement: ReceiptSettlement
  checks: ReceiptCheck[]
  links: ReceiptLinks
  limitations: string[]
}
export interface Receipt extends ReceiptCoreFields { receipt_id: string; receipt_digest: string }
export interface Attestation {
  signed: boolean
  schema_version?: string
  issuer?: string
  purpose?: string
  issued_at?: string
  key_id?: string
  algorithm?: string
  canonicalization?: string
  signature?: string
}
export interface PublicActionReceiptEnvelope {
  schema: typeof PUBLIC_ACTION_RECEIPT_SCHEMA
  receipt: Receipt
  proof: Attestation
}

const DECISION_STATUSES = new Set(['ALLOW', 'REQUIRE_APPROVAL', 'BLOCK', 'UNKNOWN'])
const EXECUTION_STATUSES = new Set(['NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN'])
const SETTLEMENT_STATUSES = new Set(['CONFIRMED', 'NOT_CONFIRMED', 'UNVERIFIED', 'NOT_APPLICABLE'])
const RECEIPT_TYPES = new Set(['PREFLIGHT', 'COMMERCE', 'ACTION'])
const CHECK_RESULTS = new Set(['PASS', 'FAIL', 'UNKNOWN', 'NOT_CHECKED'])

export function buildReceiptCore(fields: ReceiptCoreFields): ReceiptCoreFields {
  if (!RECEIPT_TYPES.has(fields.receipt_type)) throw new Error(`invalid receipt_type: ${fields.receipt_type}`)
  if (!DECISION_STATUSES.has(fields.decision.status)) throw new Error(`invalid decision.status: ${fields.decision.status}`)
  if (!EXECUTION_STATUSES.has(fields.execution.status)) throw new Error(`invalid execution.status: ${fields.execution.status}`)
  if (!SETTLEMENT_STATUSES.has(fields.settlement.status)) throw new Error(`invalid settlement.status: ${fields.settlement.status}`)
  for (const check of fields.checks) {
    if (!CHECK_RESULTS.has(check.result)) throw new Error(`invalid check result for "${check.id}": ${check.result}`)
  }
  return JSON.parse(JSON.stringify(fields)) as ReceiptCoreFields
}

export function computeReceiptDigest(core: ReceiptCoreFields): string {
  return contentId(core)
}

export function finalizeReceiptCore(core: ReceiptCoreFields): Receipt {
  const receipt_digest = computeReceiptDigest(core)
  const receipt_id = formatReceiptId(receipt_digest)
  return { ...(JSON.parse(JSON.stringify(core)) as ReceiptCoreFields), receipt_id, receipt_digest }
}

// ---------------------------------------------------------------------
// Minimal read-side verification: enough to self-check a receipt this
// service is about to serve. This intentionally does NOT reimplement the
// full tri-state TrustPolicy/key-lifecycle machinery in
// packages/agent-evidence/src/trust.ts — it fetches the API's own live key
// registry and treats an active, non-expired key as trusted. It exists so
// the bundled reference receipt can be sanity-checked at generation and
// resolve time, not as a general-purpose verifier.
// ---------------------------------------------------------------------
export type ReceiptVerificationState = 'VALID' | 'INVALID' | 'UNVERIFIABLE'

interface MinimalKeyRecord {
  key_id: string
  public_key_pem: string
  status: 'active' | 'retired' | 'revoked' | 'compromised'
  valid_from: string | null
  valid_until: string | null
}

export async function fetchAttestationKeyRegistry(
  registryUrl = 'https://api.onchaindiligence.com/.well-known/attestation-keys'
): Promise<MinimalKeyRecord[]> {
  const res = await fetch(registryUrl)
  if (!res.ok) throw new Error(`attestation key registry returned ${res.status}`)
  const body = (await res.json()) as { keys?: MinimalKeyRecord[] } | MinimalKeyRecord[]
  return Array.isArray(body) ? body : body.keys ?? []
}

export function verifyReceiptEnvelope(
  envelope: PublicActionReceiptEnvelope,
  registry: MinimalKeyRecord[],
  options: { expectedIssuer?: string; expectedPurpose?: string; now?: Date } = {}
): { state: ReceiptVerificationState; code: string; message: string } {
  if (envelope.schema !== PUBLIC_ACTION_RECEIPT_SCHEMA) {
    return { state: 'INVALID', code: 'schema-mismatch', message: 'envelope.schema is not the expected receipt schema' }
  }
  const { receipt_id, receipt_digest, ...core } = envelope.receipt
  const recomputedDigest = computeReceiptDigest(core as ReceiptCoreFields)
  if (recomputedDigest !== receipt_digest) {
    return { state: 'INVALID', code: 'digest-mismatch', message: 'receipt_digest does not match a fresh digest of the receipt content' }
  }
  if (formatReceiptId(recomputedDigest) !== receipt_id) {
    return { state: 'INVALID', code: 'id-mismatch', message: 'receipt_id does not match formatReceiptId(receipt_digest)' }
  }

  const proof = envelope.proof
  const expectedIssuer = options.expectedIssuer ?? PUBLIC_ACTION_RECEIPT_ISSUER
  const expectedPurpose = options.expectedPurpose ?? PUBLIC_ACTION_RECEIPT_PURPOSE
  if (proof.signed !== true) return { state: 'INVALID', code: 'not-signed', message: 'proof is not marked as signed' }
  if (proof.schema_version !== 'onchaindiligence.attestation.v2') {
    return { state: 'INVALID', code: 'schema-version-unsupported', message: `unsupported proof schema_version: ${proof.schema_version}` }
  }
  if (proof.algorithm !== 'ed25519') return { state: 'INVALID', code: 'algorithm-unsupported', message: `unsupported algorithm: ${proof.algorithm}` }
  if (proof.issuer !== expectedIssuer) return { state: 'INVALID', code: 'issuer-mismatch', message: 'proof issuer does not match the exact expected issuer' }
  if (proof.purpose !== expectedPurpose) return { state: 'INVALID', code: 'purpose-mismatch', message: 'proof purpose does not match the exact expected purpose' }
  if (!proof.signature || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) {
    return { state: 'INVALID', code: 'signature-encoding', message: 'signature is not 86-character unpadded base64url' }
  }

  const key = registry.find((k) => k.key_id === proof.key_id)
  if (!key) {
    return { state: 'UNVERIFIABLE', code: 'key-not-trusted', message: 'signing key is absent from the caller-supplied registry' }
  }
  if (key.status === 'revoked' || key.status === 'compromised') {
    return { state: 'INVALID', code: `key-${key.status}`, message: `signing key is ${key.status}` }
  }
  if (!key.valid_from) {
    return { state: 'UNVERIFIABLE', code: 'key-valid-from-missing', message: 'signing key has no defensible activation boundary' }
  }

  const signingInput = canonicalizeJson({
    schema_version: proof.schema_version,
    issuer: proof.issuer,
    purpose: proof.purpose,
    data: envelope.receipt,
    issued_at: proof.issued_at,
    key_id: proof.key_id,
  })
  let verified: boolean
  try {
    verified = ed25519Verify(
      null,
      Buffer.from(signingInput, 'utf8'),
      createPublicKey(key.public_key_pem),
      Buffer.from(proof.signature as string, 'base64url')
    )
  } catch {
    verified = false
  }
  if (!verified) {
    return { state: 'INVALID', code: 'signature-invalid', message: 'Ed25519 signature does not verify over the exact canonical signing input' }
  }

  const now = options.now ?? new Date()
  const issuedAtMs = Date.parse(proof.issued_at ?? '')
  const validFromMs = Date.parse(key.valid_from)
  const validUntilMs = key.valid_until ? Date.parse(key.valid_until) : Number.POSITIVE_INFINITY
  if (!Number.isFinite(issuedAtMs) || issuedAtMs < validFromMs || issuedAtMs > validUntilMs) {
    return { state: 'INVALID', code: 'key-window-violation', message: 'proof.issued_at falls outside the signing key validity window' }
  }
  if (issuedAtMs > now.getTime() + 5 * 60 * 1000) {
    return { state: 'INVALID', code: 'signature-time-future', message: 'signed time exceeds allowed clock skew' }
  }

  return { state: 'VALID', code: 'ok', message: 'receipt content, id, digest and signature are all consistent' }
}
