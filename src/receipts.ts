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

// ---------------------------------------------------------------------
// D2.3: strict exact-ISO-8601 timestamp parsing, mirroring
// packages/agent-evidence/src/canonical.ts's parseTimestamp exactly (regex
// pre-check + toISOString() round-trip) -- never a bare Date.parse()/
// new Date() on a value that could be malformed, since a malformed value
// there produces NaN, and NaN comparisons are always false (silently
// passing checks they should fail). Returns null, never NaN, on anything
// that isn't an exact "YYYY-MM-DDTHH:mm:ss.sssZ" UTC timestamp.
// ---------------------------------------------------------------------
const STRICT_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/

export function parseStrictTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !STRICT_TIMESTAMP_PATTERN.test(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null
  return ms
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

// ---------------------------------------------------------------------
// D2.3: strict, closed-schema shape validation -- reused by
// verifyReceiptEnvelope() so a correctly-signed but schema-invalid receipt
// (an illegal enum value, an extra field, a missing required field) can
// never verify VALID. buildReceiptCore() only runs this at CONSTRUCTION
// time; a receipt assembled by hand (bypassing buildReceiptCore) and then
// digested/signed would otherwise sail through verification untouched,
// since digest/id/signature checks alone only prove self-consistency, not
// schema conformance. Mirrors (by hand; see file header) the closed-schema
// semantics of spec/agent-evidence/v0/schema/public-action-receipt.schema.json
// (additionalProperties: false at every level) without an Ajv dependency.
// ---------------------------------------------------------------------
function closedKeys(value: unknown, required: readonly string[], label: string, optional: readonly string[] = []): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${label} must be an object`
  }
  const allowedSet = new Set([...required, ...optional])
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowedSet.has(key)) return `${label} has an unexpected field: ${key}`
  }
  for (const key of required) {
    if (!(key in (value as Record<string, unknown>))) return `${label} is missing required field: ${key}`
  }
  return null
}

function validateReceiptShape(envelope: unknown): string | null {
  const envelopeError = closedKeys(envelope, ['schema', 'receipt', 'proof'], 'envelope')
  if (envelopeError) return envelopeError
  const { receipt, proof } = envelope as { receipt: unknown; proof: unknown }

  const receiptError = closedKeys(
    receipt,
    ['receipt_id', 'receipt_digest', 'receipt_type', 'issued_at', 'action', 'decision', 'execution', 'settlement', 'checks', 'links', 'limitations'],
    'receipt'
  )
  if (receiptError) return receiptError
  const r = receipt as ReceiptCoreFields & { receipt_id: unknown; receipt_digest: unknown }
  if (!RECEIPT_TYPES.has(r.receipt_type)) return `receipt.receipt_type is not a recognized enum value: ${r.receipt_type}`
  if (typeof r.receipt_id !== 'string' || typeof r.receipt_digest !== 'string') return 'receipt_id/receipt_digest must be strings'

  const actionError = closedKeys(r.action, ['kind', 'resource', 'network', 'asset', 'amount', 'sender', 'recipient'], 'receipt.action')
  if (actionError) return actionError

  const decisionError = closedKeys(r.decision, ['status', 'authorized', 'reasons'], 'receipt.decision')
  if (decisionError) return decisionError
  if (!DECISION_STATUSES.has(r.decision.status)) return `receipt.decision.status is not a recognized enum value: ${r.decision.status}`
  if (r.decision.authorized !== null && typeof r.decision.authorized !== 'boolean') return 'receipt.decision.authorized must be boolean or null'
  if (!Array.isArray(r.decision.reasons) || r.decision.reasons.some((x) => typeof x !== 'string')) {
    return 'receipt.decision.reasons must be an array of strings'
  }

  const executionError = closedKeys(r.execution, ['provider', 'status', 'transaction_hash', 'submitted_at', 'confirmed_at'], 'receipt.execution')
  if (executionError) return executionError
  if (!EXECUTION_STATUSES.has(r.execution.status)) return `receipt.execution.status is not a recognized enum value: ${r.execution.status}`

  const settlementError = closedKeys(r.settlement, ['status', 'detail'], 'receipt.settlement')
  if (settlementError) return settlementError
  if (!SETTLEMENT_STATUSES.has(r.settlement.status)) return `receipt.settlement.status is not a recognized enum value: ${r.settlement.status}`

  if (!Array.isArray(r.checks)) return 'receipt.checks must be an array'
  for (const [index, check] of r.checks.entries()) {
    const checkError = closedKeys(check, ['id', 'result', 'summary', 'evidence_digest'], `receipt.checks[${index}]`)
    if (checkError) return checkError
    if (!CHECK_RESULTS.has(check.result)) return `receipt.checks[${index}].result is not a recognized enum value: ${check.result}`
  }

  const linksError = closedKeys(r.links, ['agent_evidence_bundle_digest', 'preflight_receipt_id'], 'receipt.links')
  if (linksError) return linksError

  if (!Array.isArray(r.limitations) || r.limitations.some((x) => typeof x !== 'string')) {
    return 'receipt.limitations must be an array of strings'
  }

  const proofError = closedKeys(
    proof,
    ['signed', 'schema_version', 'issuer', 'purpose', 'issued_at', 'key_id', 'algorithm', 'canonicalization', 'signature'],
    'proof',
    ['signing_input_hint']
  )
  if (proofError) return proofError

  return null
}

export interface StructuralIntegrityResult {
  ok: boolean
  code: string
  message: string
}

/**
 * D2.3 (Task 4): the LOCAL, network-free half of receipt verification --
 * schema shape, receipt_digest, and receipt_id self-consistency. No key
 * registry, no signature check, no network call of any kind. This is what
 * the public resolver (receiptsRoute.ts) uses to distinguish a genuinely
 * corrupt/malformed stored row (reject) from a structurally sound receipt
 * whose TRUST cannot currently be confirmed because the key registry is
 * temporarily unreachable (still serve it — see that file's comments).
 * verifyReceiptEnvelope() below calls this first and continues into the
 * proof/signature/lifecycle checks only if it passes.
 */
export function checkReceiptStructuralIntegrity(envelope: unknown): StructuralIntegrityResult {
  const shapeError = validateReceiptShape(envelope)
  if (shapeError) return { ok: false, code: 'schema-invalid', message: shapeError }
  const e = envelope as PublicActionReceiptEnvelope
  if (e.schema !== PUBLIC_ACTION_RECEIPT_SCHEMA) {
    return { ok: false, code: 'schema-mismatch', message: 'envelope.schema is not the expected receipt schema' }
  }
  const { receipt_id, receipt_digest, ...core } = e.receipt
  const recomputedDigest = computeReceiptDigest(core as ReceiptCoreFields)
  if (recomputedDigest !== receipt_digest) {
    return { ok: false, code: 'digest-mismatch', message: 'receipt_digest does not match a fresh digest of the receipt content' }
  }
  if (formatReceiptId(recomputedDigest) !== receipt_id) {
    return { ok: false, code: 'id-mismatch', message: 'receipt_id does not match formatReceiptId(receipt_digest)' }
  }
  return { ok: true, code: 'ok', message: 'receipt content, digest, and id are self-consistent' }
}

export function verifyReceiptEnvelope(
  envelope: PublicActionReceiptEnvelope,
  registry: MinimalKeyRecord[],
  options: { expectedIssuer?: string; expectedPurpose?: string; now?: Date } = {}
): { state: ReceiptVerificationState; code: string; message: string } {
  const structural = checkReceiptStructuralIntegrity(envelope)
  if (!structural.ok) {
    return { state: 'INVALID', code: structural.code, message: structural.message }
  }

  const proof = envelope.proof
  const expectedIssuer = options.expectedIssuer ?? PUBLIC_ACTION_RECEIPT_ISSUER
  const expectedPurpose = options.expectedPurpose ?? PUBLIC_ACTION_RECEIPT_PURPOSE
  if (proof.signed !== true) return { state: 'INVALID', code: 'not-signed', message: 'proof is not marked as signed' }
  if (proof.schema_version !== 'onchaindiligence.attestation.v2') {
    return { state: 'INVALID', code: 'schema-version-unsupported', message: `unsupported proof schema_version: ${proof.schema_version}` }
  }
  if (proof.algorithm !== 'ed25519') return { state: 'INVALID', code: 'algorithm-unsupported', message: `unsupported algorithm: ${proof.algorithm}` }
  if (proof.canonicalization !== 'RFC8785') {
    return { state: 'INVALID', code: 'canonicalization-unsupported', message: `unsupported canonicalization: ${proof.canonicalization}` }
  }
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

  // D2.3: strict timestamp parsing everywhere below -- never Date.parse()
  // on a value that might be malformed. A NaN comparison is always false,
  // so "issuedAtMs < validFromMs" with a garbage (non-null) valid_from used
  // to silently pass this gate entirely (neither side of the OR fired) and
  // fall through to VALID. Distinguish WHO controls the malformed value:
  // proof.issued_at is signer-asserted content -> a malformed value there
  // is INVALID (the signed content itself is broken). key.valid_from/
  // valid_until are externally-registered infrastructure metadata -> a
  // malformed value there is UNVERIFIABLE (no defensible trust boundary),
  // exactly like the already-handled "missing" case above -- never
  // silently treated as "no boundary" (which is what NaN comparisons did).
  const now = options.now ?? new Date()
  const issuedAtMs = parseStrictTimestamp(proof.issued_at)
  if (issuedAtMs === null) {
    return { state: 'INVALID', code: 'issued-at-invalid', message: 'proof.issued_at is not an exact UTC ISO-8601 timestamp' }
  }
  const validFromMs = parseStrictTimestamp(key.valid_from)
  if (validFromMs === null) {
    return { state: 'UNVERIFIABLE', code: 'key-valid-from-invalid', message: 'signing key valid_from is not a well-formed timestamp -- no defensible activation boundary' }
  }
  let validUntilMs = Number.POSITIVE_INFINITY
  if (key.valid_until !== null && key.valid_until !== undefined) {
    const parsedValidUntil = parseStrictTimestamp(key.valid_until)
    if (parsedValidUntil === null) {
      return { state: 'UNVERIFIABLE', code: 'key-valid-until-invalid', message: 'signing key valid_until is not a well-formed timestamp' }
    }
    validUntilMs = parsedValidUntil
  }
  if (issuedAtMs < validFromMs) {
    return { state: 'INVALID', code: 'key-not-yet-valid', message: "proof.issued_at is before the signing key's valid_from" }
  }
  if (issuedAtMs > validUntilMs) {
    return { state: 'INVALID', code: 'key-expired', message: "proof.issued_at is after the signing key's valid_until" }
  }
  if (issuedAtMs > now.getTime() + 5 * 60 * 1000) {
    return { state: 'INVALID', code: 'signature-time-future', message: 'signed time exceeds allowed clock skew' }
  }

  return { state: 'VALID', code: 'ok', message: 'receipt content, id, digest and signature are all consistent' }
}
