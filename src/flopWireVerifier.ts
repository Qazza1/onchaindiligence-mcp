/**
 * flopWireVerifier.ts — D3.5D-B offline FLOP wire/receipt conformance verifier.
 *
 * Answers ONE question: does a supplied FLOP artifact (channel_id claim,
 * session-transcript leaf, compute-channel receipt, or Merkle inclusion
 * path) conform to the currently published normative wire-format rules in
 * the FLOP Yellow Paper (flop-labs/yellowpaper, Appendix F)?
 *
 * This is NOT a FLOP executor, chain watcher, or HTLC implementation. It
 * opens no channel, submits nothing, watches no chain, and holds no key of
 * any kind -- it only recomputes a hash/signature over caller-supplied
 * bytes and compares. Everything here runs fully offline.
 *
 * Pinned source: flop-labs/yellowpaper @ cb3cbf97a346ff85aca6dba5e924434270ca672c
 * (repo HEAD as of this module's authoring; the wire-format corpus content
 * itself is unchanged since the 2026-09-10 sync commit 3eaf2f25). See
 * docs/FLOP_WIRE_VERIFIER.md for exactly what this means and how to update
 * it when FLOP publishes a new canonical corpus.
 *
 * Cryptographic primitives used (chosen and proven against FLOP's own
 * public vectors before this module was written -- see
 * test/flopWireVerifier.test.ts, which reproduces channel_id, all four
 * leaf-version hashes, the receipt signature, the V3 leaf signature, and a
 * full Merkle root byte-for-byte from the corpus):
 *   - blake2b-256 (@noble/hashes) for channel_id, leaf hashes, Merkle nodes
 *   - sr25519 / Schnorrkel (@scure/sr25519) for receipt and leaf signatures
 *
 * Claim discipline (Appendix F.0, F.3; D-0505): VALID here means the
 * artifact's structure/hash/signature checked out under FLOP's own
 * published wire rules -- nothing more. It does NOT mean: inference output
 * was correct, GPU work actually occurred, output quality was good,
 * settlement occurred on-chain, an HTLC pair completed, or any service was
 * delivered. Those are runtime/settlement claims this module does not and
 * cannot check (see docs/FLOP_WIRE_VERIFIER.md).
 */
import { blake2b } from '@noble/hashes/blake2b.js'
import { verify as sr25519Verify } from '@scure/sr25519'

// Note: F.1's decode_policy_hash and report_data use SHA256, not blake2b --
// but neither is one of the four artifact types this verifier slice covers
// (channel_id, leaf, receipt, merkle_path), so no SHA256 import is needed
// here yet. See docs/FLOP_WIRE_VERIFIER.md "Known unsupported areas."

export const FLOP_SPEC_VERSION = 'v0.5.0 (draft)'
export const FLOP_SPEC_REVISION = 'cb3cbf97a346ff85aca6dba5e924434270ca672c'
export const FLOP_CORPUS_STATUS = 'public-canonical' // as declared by evidence/wire-format-v1.json itself

/** Reuses OCD's own existing tri-state verification vocabulary (receipts.ts's
 * ReceiptVerificationState) rather than inventing a new one. */
export type FlopVerificationState = 'VALID' | 'INVALID' | 'UNVERIFIABLE'

export type FlopArtifactType = 'channel_id' | 'leaf' | 'receipt' | 'merkle_path'

export interface FlopVerificationResult {
  state: FlopVerificationState
  protocol: 'flop'
  spec_version: string
  spec_revision: string
  artifact_type: FlopArtifactType
  verified_checks: string[]
  failed_checks: string[]
  unknowns: string[]
  message: string
}

export interface ChannelIdArtifact {
  type: 'channel_id'
  claimed_channel_id_hex: string
  genesis_hash_hex: string
  agent_account_id32_hex: string
  miner_account_id32_hex: string
  nonce: number | bigint | string
}

export const LEAF_VERSIONS = ['V0', 'V1', 'V2', 'V3'] as const
export type LeafVersion = (typeof LEAF_VERSIONS)[number]

export interface LeafArtifact {
  type: 'leaf'
  version: string // deliberately unnarrowed -- an out-of-range value must fail closed, not fail to type-check
  claimed_hash_hex: string
  channel_id_hex: string
  turn_index: number
  h_in_hex: string
  h_out_hex: string
  g_n: number | bigint | string
  /** Required from V2 onward; absence on V2/V3 or presence on V0/V1 is a rejection (F.3's version-field consistency rule). */
  decode_policy_hash_hex?: string
  /** Required from V3 onward only. */
  h_ids_hex?: string
  toploc_commitment_hash_hex?: string
  /** Required from V1 onward only. */
  miner_recv_ms?: number | bigint | string
  miner_done_ms?: number | bigint | string
  latency_ms?: number | bigint | string
}

export interface ReceiptArtifact {
  type: 'receipt'
  channel_id_hex: string
  final_root_hex: string
  aggregate_gn: number | bigint | string
  payable: number | bigint | string
  signature_hex: string
  public_key_hex: string
}

export interface MerklePathArtifact {
  type: 'merkle_path'
  leaf_hash_hex: string
  path: Array<{ sibling_hex: string; sibling_is_left: boolean }>
  claimed_root_hex: string
}

export type FlopArtifact = ChannelIdArtifact | LeafArtifact | ReceiptArtifact | MerklePathArtifact

// --------------------------------------------------------------------------
// F.0 codec primitives -- fixed-width, fail-closed. No saturation,
// truncation, or floating-point conversion is ever permitted (F.0).
// --------------------------------------------------------------------------

const HEX_PATTERN = /^[0-9a-fA-F]*$/

function hexToBytes(hex: string, expectedBytes?: number): Uint8Array | null {
  if (typeof hex !== 'string' || !HEX_PATTERN.test(hex) || hex.length % 2 !== 0) return null
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fixed unsigned little-endian integer. Rejects negative/overflowing input
 * -- never silently wraps (F.0). Accepts a decimal string for u128/near-u64
 * values that exceed Number.MAX_SAFE_INTEGER (the corpus's own boundary
 * vectors use strings for exactly this reason, e.g. leaf_inputs.g_n =
 * "340282366920938463463374607431768211455" = u128::MAX) -- BigInt(string)
 * parses the exact decimal value; routing a number through Math.trunc
 * first would silently lose precision above 2^53.
 */
function uintLE(value: number | bigint | string, byteLength: number): Uint8Array | null {
  let v: bigint
  try {
    if (typeof value === 'bigint') v = value
    else if (typeof value === 'string') {
      if (!/^\d+$/.test(value)) return null
      v = BigInt(value)
    } else {
      if (!Number.isFinite(value) || !Number.isInteger(value)) return null
      v = BigInt(value)
    }
  } catch {
    return null
  }
  if (v < 0n) return null
  const max = (1n << BigInt(byteLength * 8)) - 1n
  if (v > max) return null
  const out = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function ascii(s: string): Uint8Array {
  return new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function blake2_256(msg: Uint8Array): Uint8Array {
  return blake2b(msg, { dkLen: 32 })
}

// --------------------------------------------------------------------------
// F.1 -- channel_id v1
// --------------------------------------------------------------------------

const CHANNEL_ID_DOMAIN = ascii('FLOP/COMPUTE_CHANNEL/ID')
const CHANNEL_ID_VERSION_BYTE = new Uint8Array([0x01])

function deriveChannelId(genesisHash: Uint8Array, agent: Uint8Array, miner: Uint8Array, nonce: Uint8Array): Uint8Array {
  return blake2_256(concat(CHANNEL_ID_DOMAIN, CHANNEL_ID_VERSION_BYTE, genesisHash, agent, miner, nonce))
}

function verifyChannelId(artifact: ChannelIdArtifact): FlopVerificationResult {
  const verified: string[] = []
  const failed: string[] = []
  const unknowns: string[] = []

  const genesisHash = hexToBytes(artifact.genesis_hash_hex, 32)
  const agent = hexToBytes(artifact.agent_account_id32_hex, 32)
  const miner = hexToBytes(artifact.miner_account_id32_hex, 32)
  const nonce = uintLE(artifact.nonce, 8)
  const claimed = hexToBytes(artifact.claimed_channel_id_hex, 32)

  if (!genesisHash) failed.push('genesis_hash_hex must be exactly 32 bytes of hex')
  if (!agent) failed.push('agent_account_id32_hex must be exactly 32 bytes of hex')
  if (!miner) failed.push('miner_account_id32_hex must be exactly 32 bytes of hex')
  if (!nonce) failed.push('nonce must be a non-negative integer representable in u64')
  if (!claimed) failed.push('claimed_channel_id_hex must be exactly 32 bytes of hex')

  if (failed.length > 0) {
    return result('INVALID', 'channel_id', verified, failed, unknowns, 'malformed channel_id artifact fields (F.0 fail-closed)')
  }

  const computed = deriveChannelId(genesisHash!, agent!, miner!, nonce!)
  verified.push('channel_id preimage constructed per Appendix F.1 (FLOP/COMPUTE_CHANNEL/ID domain, version 01)')

  if (bytesToHex(computed) !== bytesToHex(claimed!)) {
    failed.push('claimed channel_id does not match blake2_256(preimage) recomputed from the supplied inputs')
    return result('INVALID', 'channel_id', verified, failed, unknowns, 'channel_id derivation mismatch')
  }
  verified.push('claimed channel_id matches blake2_256 derivation exactly')
  return result('VALID', 'channel_id', verified, failed, unknowns, 'channel_id derivation conforms to Appendix F.1')
}

// --------------------------------------------------------------------------
// F.3 -- session transcript leaf versions V0-V3
// --------------------------------------------------------------------------

/** Field-presence consistency per version, per F.3's own accepted-version-cutoff rule:
 * a V2/V3 leaf lacking its required fields (or a V0/V1 leaf carrying fields it must not
 * have) is exactly the LeafFieldsInconsistent rejection the corpus's `wrong_leaf_version`
 * negative case exercises. */
function leafFieldConsistency(a: LeafArtifact): string | null {
  const hasDecodePolicy = a.decode_policy_hash_hex !== undefined
  const hasV3Fields = a.h_ids_hex !== undefined || a.toploc_commitment_hash_hex !== undefined
  const hasTiming = a.miner_recv_ms !== undefined || a.miner_done_ms !== undefined || a.latency_ms !== undefined

  if (a.version === 'V0') {
    if (hasTiming || hasDecodePolicy || hasV3Fields) return 'V0 leaf must carry no timing, decode-policy, or V3 fields'
  } else if (a.version === 'V1') {
    if (!hasTiming) return 'V1 leaf requires miner_recv_ms, miner_done_ms, latency_ms'
    if (hasDecodePolicy || hasV3Fields) return 'V1 leaf must carry no decode-policy or V3 fields'
  } else if (a.version === 'V2') {
    if (!hasTiming) return 'V2 leaf requires miner_recv_ms, miner_done_ms, latency_ms'
    if (!hasDecodePolicy) return 'V2 leaf requires decode_policy_hash_hex'
    if (hasV3Fields) return 'V2 leaf must carry no h_ids/toploc_commitment_hash (would misrepresent it as V3/TOPLOC-bound, #1404)'
  } else if (a.version === 'V3') {
    if (!hasTiming) return 'V3 leaf requires miner_recv_ms, miner_done_ms, latency_ms'
    if (!hasDecodePolicy) return 'V3 leaf requires decode_policy_hash_hex'
    if (!hasV3Fields || !a.h_ids_hex || !a.toploc_commitment_hash_hex) return 'V3 leaf requires non-zero h_ids_hex and toploc_commitment_hash_hex (F.3: h_ids MUST be non-zero in FCC4)'
  }
  return null
}

function buildLeafPreimage(a: LeafArtifact): Uint8Array | null {
  const channelId = hexToBytes(a.channel_id_hex, 32)
  const turnIndex = uintLE(a.turn_index, 4)
  const hIn = hexToBytes(a.h_in_hex, 32)
  const hOut = hexToBytes(a.h_out_hex, 32)
  const gN = uintLE(a.g_n, 16)
  if (!channelId || !turnIndex || !hIn || !hOut || !gN) return null

  const base = [channelId, turnIndex, hIn, hOut, gN]
  if (a.version === 'V0') return concat(...base)

  const timing = () => {
    const recv = uintLE(a.miner_recv_ms ?? -1, 8)
    const done = uintLE(a.miner_done_ms ?? -1, 8)
    const lat = uintLE(a.latency_ms ?? -1, 8)
    return recv && done && lat ? [recv, done, lat] : null
  }

  if (a.version === 'V1') {
    const t = timing()
    return t ? concat(...base, ...t) : null
  }
  const policy = hexToBytes(a.decode_policy_hash_hex ?? '', 32)
  if (a.version === 'V2') {
    const t = timing()
    return t && policy ? concat(...base, policy, ...t) : null
  }
  if (a.version === 'V3') {
    const t = timing()
    const hIds = hexToBytes(a.h_ids_hex ?? '', 32)
    const toploc = hexToBytes(a.toploc_commitment_hash_hex ?? '', 32)
    return t && policy && hIds && toploc ? concat(...base, policy, hIds, toploc, ...t) : null
  }
  return null
}

function verifyLeaf(artifact: LeafArtifact): FlopVerificationResult {
  const verified: string[] = []
  const failed: string[] = []
  const unknowns: string[] = []

  if (!LEAF_VERSIONS.includes(artifact.version as LeafVersion)) {
    failed.push(`unsupported leaf version tag "${artifact.version}" -- only V0-V3 are defined by the current spec (F.0: unknown tags MUST be rejected)`)
    return result('INVALID', 'leaf', verified, failed, unknowns, 'unknown leaf version tag, fail-closed')
  }
  verified.push(`leaf version tag "${artifact.version}" is within the defined V0-V3 range`)

  const consistencyError = leafFieldConsistency(artifact)
  if (consistencyError) {
    failed.push(consistencyError)
    return result('INVALID', 'leaf', verified, failed, unknowns, 'leaf field-presence inconsistent with its declared version (F.3)')
  }
  verified.push('leaf field presence is consistent with its declared version (F.3 LeafFieldsInconsistent check)')

  const claimed = hexToBytes(artifact.claimed_hash_hex, 32)
  if (!claimed) {
    failed.push('claimed_hash_hex must be exactly 32 bytes of hex')
    return result('INVALID', 'leaf', verified, failed, unknowns, 'malformed claimed hash')
  }
  const preimage = buildLeafPreimage(artifact)
  if (!preimage) {
    failed.push('one or more leaf fields are malformed or out of range for its declared version')
    return result('INVALID', 'leaf', verified, failed, unknowns, 'malformed leaf fields, fail-closed (F.0)')
  }
  verified.push(`leaf preimage constructed per Appendix F.3 for ${artifact.version}`)

  const computed = blake2_256(preimage)
  if (bytesToHex(computed) !== bytesToHex(claimed)) {
    failed.push('claimed leaf hash does not match blake2_256(preimage) recomputed from the supplied fields')
    return result('INVALID', 'leaf', verified, failed, unknowns, 'leaf hash mismatch')
  }
  verified.push('claimed leaf hash matches blake2_256 derivation exactly')
  return result('VALID', 'leaf', verified, failed, unknowns, `${artifact.version} leaf conforms to Appendix F.3`)
}

// --------------------------------------------------------------------------
// F.3 -- compute-channel agent receipt v1
// --------------------------------------------------------------------------

const RECEIPT_DOMAIN = ascii('FLOP/COMPUTE_CHANNEL/RECEIPT')
const RECEIPT_VERSION_BYTE = new Uint8Array([0x01])

function verifyReceiptArtifact(artifact: ReceiptArtifact): FlopVerificationResult {
  const verified: string[] = []
  const failed: string[] = []
  const unknowns: string[] = []

  const channelId = hexToBytes(artifact.channel_id_hex, 32)
  const finalRoot = hexToBytes(artifact.final_root_hex, 32)
  const aggregateGn = uintLE(artifact.aggregate_gn, 16)
  const payable = uintLE(artifact.payable, 16)
  const signature = hexToBytes(artifact.signature_hex, 64)
  const publicKey = hexToBytes(artifact.public_key_hex, 32)

  if (!channelId) failed.push('channel_id_hex must be exactly 32 bytes of hex')
  if (!finalRoot) failed.push('final_root_hex must be exactly 32 bytes of hex')
  if (!aggregateGn) failed.push('aggregate_gn must be a non-negative integer representable in u128')
  if (!payable) failed.push('payable must be a non-negative integer representable in u128')
  if (!signature) failed.push('signature_hex must be exactly 64 bytes of hex')
  if (!publicKey) failed.push('public_key_hex must be exactly 32 bytes of hex')

  if (failed.length > 0) {
    return result('INVALID', 'receipt', verified, failed, unknowns, 'malformed receipt artifact fields (F.0 fail-closed)')
  }

  const preimage = concat(RECEIPT_DOMAIN, RECEIPT_VERSION_BYTE, channelId!, finalRoot!, aggregateGn!, payable!)
  verified.push('receipt preimage reconstructed per Appendix F.3 (FLOP/COMPUTE_CHANNEL/RECEIPT domain, version 01)')

  let sigValid: boolean
  try {
    sigValid = sr25519Verify(preimage, signature!, publicKey!)
  } catch (err) {
    failed.push(`sr25519 signature check could not run: ${err instanceof Error ? err.message : String(err)}`)
    return result('INVALID', 'receipt', verified, failed, unknowns, 'malformed signature/public key bytes, fail-closed')
  }

  if (!sigValid) {
    failed.push('sr25519 signature over the reconstructed preimage does not verify against the supplied public key')
    return result('INVALID', 'receipt', verified, failed, unknowns, 'receipt signature does not verify')
  }
  verified.push('sr25519 signature verifies against the supplied public key over the reconstructed preimage')
  return result(
    'VALID',
    'receipt',
    verified,
    failed,
    unknowns,
    'receipt structure and signature conform to Appendix F.3. This confirms the receipt was signed over these exact channel_id/root/aggregate/payout values -- it does NOT confirm those values were independently observed on-chain or that any settlement occurred.'
  )
}

// --------------------------------------------------------------------------
// Merkle inclusion path (F.3)
// --------------------------------------------------------------------------

function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2_256(concat(left, right))
}

function verifyMerklePath(artifact: MerklePathArtifact): FlopVerificationResult {
  const verified: string[] = []
  const failed: string[] = []
  const unknowns: string[] = []

  const leafHash = hexToBytes(artifact.leaf_hash_hex, 32)
  const claimedRoot = hexToBytes(artifact.claimed_root_hex, 32)
  if (!leafHash) failed.push('leaf_hash_hex must be exactly 32 bytes of hex')
  if (!claimedRoot) failed.push('claimed_root_hex must be exactly 32 bytes of hex')
  if (!Array.isArray(artifact.path)) failed.push('path must be an array of {sibling_hex, sibling_is_left} steps')

  if (failed.length > 0) {
    return result('INVALID', 'merkle_path', verified, failed, unknowns, 'malformed merkle_path artifact fields (F.0 fail-closed)')
  }

  let current = leafHash!
  for (let i = 0; i < artifact.path.length; i++) {
    const step = artifact.path[i]
    const sibling = hexToBytes(step.sibling_hex, 32)
    if (!sibling || typeof step.sibling_is_left !== 'boolean') {
      failed.push(`path step ${i} is malformed (sibling_hex must be 32 bytes of hex; sibling_is_left must be boolean)`)
      return result('INVALID', 'merkle_path', verified, failed, unknowns, 'malformed path step, fail-closed')
    }
    current = step.sibling_is_left ? merkleNode(sibling, current) : merkleNode(current, sibling)
  }
  verified.push(`Merkle path of length ${artifact.path.length} replayed per F.3 (blake2_256(left‖right) per node, no prefix)`)

  if (bytesToHex(current) !== bytesToHex(claimedRoot!)) {
    failed.push('root reconstructed from the leaf and path does not match the claimed root')
    return result('INVALID', 'merkle_path', verified, failed, unknowns, 'Merkle path does not reconstruct the claimed root')
  }
  verified.push('reconstructed root matches the claimed root exactly')
  return result('VALID', 'merkle_path', verified, failed, unknowns, 'Merkle inclusion path conforms to Appendix F.3')
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

function result(
  state: FlopVerificationState,
  artifactType: FlopArtifactType,
  verified: string[],
  failed: string[],
  unknowns: string[],
  message: string
): FlopVerificationResult {
  return {
    state,
    protocol: 'flop',
    spec_version: FLOP_SPEC_VERSION,
    spec_revision: FLOP_SPEC_REVISION,
    artifact_type: artifactType,
    verified_checks: verified,
    failed_checks: failed,
    unknowns,
    message,
  }
}

/**
 * Verify one FLOP wire artifact against the current normative Appendix F
 * rules. Pure, synchronous, fully offline -- makes no network call, opens
 * no channel, and never touches a private key.
 *
 * VALID means the artifact's structure/hash/signature checked out under
 * FLOP's own published wire rules -- see this file's header for the full
 * list of what it does NOT mean.
 */
export function verifyFlopArtifact(artifact: FlopArtifact): FlopVerificationResult {
  switch (artifact.type) {
    case 'channel_id':
      return verifyChannelId(artifact)
    case 'leaf':
      return verifyLeaf(artifact)
    case 'receipt':
      return verifyReceiptArtifact(artifact)
    case 'merkle_path':
      return verifyMerklePath(artifact)
    default:
      return result(
        'UNVERIFIABLE',
        (artifact as { type: FlopArtifactType }).type,
        [],
        [],
        [`artifact_type "${(artifact as { type: string }).type}" is not supported by this verifier slice (D3.5D-B covers channel_id, leaf, receipt, merkle_path only)`],
        'unsupported artifact type for this verifier'
      )
  }
}

/**
 * Normalizes a VERIFIED FLOP artifact into an OCD-evidence-shaped summary.
 *
 * This is explicitly NOT an independent observation -- it is a structural
 * summary of what was cryptographically checked, one level up from a raw
 * FlopVerificationResult. Every field here traces back to caller-supplied
 * bytes this module verified the internal consistency of; none of it was
 * independently observed on a chain (that is D3.5D-C's job, not this
 * module's). Callers integrating this into an OCD Investigation MUST NOT
 * present these fields as settlement evidence.
 */
export interface FlopEvidenceSummary {
  spec_version: string
  spec_revision: string
  artifact_type: FlopArtifactType
  channel_id_hex: string | null
  leaf_version: string | null
  task_hash_hex: null // not covered by this verifier slice; see docs
  participants: { agent_account_id32_hex: string | null; miner_account_id32_hex: string | null }
  receipt_reference: { final_root_hex: string | null; aggregate_gn: string | null; payable: string | null } | null
  cryptographically_verified_fields: string[]
  verification_outcome: FlopVerificationState
  evidence_class: 'artifact-structure-only'
}

export function normalizeFlopArtifactEvidence(artifact: FlopArtifact, verification: FlopVerificationResult): FlopEvidenceSummary {
  return {
    spec_version: verification.spec_version,
    spec_revision: verification.spec_revision,
    artifact_type: verification.artifact_type,
    channel_id_hex: artifact.type === 'channel_id' ? artifact.claimed_channel_id_hex : artifact.type === 'leaf' ? artifact.channel_id_hex : artifact.type === 'receipt' ? artifact.channel_id_hex : null,
    leaf_version: artifact.type === 'leaf' ? artifact.version : null,
    task_hash_hex: null,
    participants: {
      agent_account_id32_hex: artifact.type === 'channel_id' ? artifact.agent_account_id32_hex : null,
      miner_account_id32_hex: artifact.type === 'channel_id' ? artifact.miner_account_id32_hex : null,
    },
    receipt_reference:
      artifact.type === 'receipt'
        ? { final_root_hex: artifact.final_root_hex, aggregate_gn: String(artifact.aggregate_gn), payable: String(artifact.payable) }
        : null,
    cryptographically_verified_fields: verification.verified_checks,
    verification_outcome: verification.state,
    evidence_class: 'artifact-structure-only',
  }
}
