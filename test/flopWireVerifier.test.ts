/**
 * D3.5D-B — FLOP is FLOP's own canonical acceptance suite. Per the task
 * instruction "avoid creating a large parallel custom test corpus," this
 * file does not invent synthetic fixtures for the positive/version cases --
 * it drives verifyFlopArtifact() with the exact vectors published in
 * test/fixtures/flop-wire-format-v1.json (vendored from flop-labs/yellowpaper
 * @ cb3cbf97a346ff85aca6dba5e924434270ca672c) and asserts the same
 * accept/reject outcome FLOP's own Rust/TS/Python tests assert against that
 * same file (Appendix F: "Rust, TypeScript, and Python tests consume that
 * same file").
 *
 * A handful of hand-built cases are still needed for negative fixtures that
 * require MUTATING a canonical positive vector (flip a byte, change a
 * field) -- those mutations are spelled out inline, each one directly
 * mirroring a specific entry in the corpus's own `negative_cases` array
 * (see the comment on each test).
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  FLOP_SPEC_REVISION,
  normalizeFlopArtifactEvidence,
  verifyFlopArtifact,
  type ChannelIdArtifact,
  type LeafArtifact,
  type MerklePathArtifact,
  type ReceiptArtifact,
} from '../src/flopWireVerifier.js'

const fixturePath = new URL('./fixtures/flop-wire-format-v1.json', import.meta.url)
const corpus = JSON.parse(readFileSync(fixturePath, 'utf8'))
const cc = corpus.compute_channel_v1

test('vendored fixture pins the exact FLOP revision this module targets', () => {
  assert.equal(corpus.status, 'public-canonical')
  // The corpus file itself doesn't carry a git SHA -- FLOP_SPEC_REVISION is
  // recorded at vendoring time (see flopWireVerifier.ts header) and checked
  // manually against `git -C <clone> rev-parse HEAD` when refreshed.
  assert.equal(typeof FLOP_SPEC_REVISION, 'string')
  assert.equal(FLOP_SPEC_REVISION.length, 40)
})

// ---------------------------------------------------------------------
// Positive canonical vectors
// ---------------------------------------------------------------------

test('canonical channel_id vector verifies VALID', () => {
  const artifact: ChannelIdArtifact = {
    type: 'channel_id',
    claimed_channel_id_hex: cc.channel_id.hash_hex,
    genesis_hash_hex: cc.channel_id.inputs.genesis_hash_hex,
    agent_account_id32_hex: cc.channel_id.inputs.agent_account_id32_hex,
    miner_account_id32_hex: cc.channel_id.inputs.miner_account_id32_hex,
    nonce: cc.channel_id.inputs.nonce,
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'VALID')
  assert.equal(r.spec_revision, FLOP_SPEC_REVISION)
  assert.ok(r.verified_checks.length > 0)
})

for (const lv of cc.leaf_versions) {
  test(`canonical ${lv.version} leaf vector verifies VALID`, () => {
    // The corpus's leaf_versions fixtures share one input set with fields
    // added per version (F.3); reconstruct exactly what each version's
    // preimage requires from the fixed 236 B V3 field layout the corpus
    // documents alongside compute_channel_v1.leaf_inputs.
    const inputs = cc.leaf_inputs
    const artifact: LeafArtifact = {
      type: 'leaf',
      version: lv.version,
      claimed_hash_hex: lv.hash_hex,
      channel_id_hex: inputs.channel_id_hex,
      turn_index: inputs.turn_index,
      h_in_hex: inputs.h_in_hex,
      h_out_hex: inputs.h_out_hex,
      g_n: inputs.g_n,
      ...(lv.version !== 'V0'
        ? { miner_recv_ms: inputs.miner_recv_ms, miner_done_ms: inputs.miner_done_ms, latency_ms: inputs.latency_ms }
        : {}),
      ...(lv.version === 'V2' || lv.version === 'V3' ? { decode_policy_hash_hex: inputs.decode_policy_hash_hex } : {}),
      ...(lv.version === 'V3' ? { h_ids_hex: inputs.h_ids_hex, toploc_commitment_hash_hex: inputs.toploc_commitment_hash_hex } : {}),
    }
    const r = verifyFlopArtifact(artifact)
    assert.equal(r.state, 'VALID', JSON.stringify(r.failed_checks))
  })
}

test('canonical receipt vector verifies VALID (signature checks out)', () => {
  const r = cc.receipt
  const artifact: ReceiptArtifact = {
    type: 'receipt',
    channel_id_hex: r.inputs.channel_id_hex,
    final_root_hex: r.inputs.final_root_hex,
    aggregate_gn: r.inputs.aggregate_gn,
    payable: r.inputs.payable,
    signature_hex: r.signature_hex,
    public_key_hex: r.public_key_hex,
  }
  const result = verifyFlopArtifact(artifact)
  assert.equal(result.state, 'VALID')
  assert.match(result.message, /does NOT confirm/)

  const evidence = normalizeFlopArtifactEvidence(artifact, result)
  assert.equal(evidence.evidence_class, 'artifact-structure-only')
  assert.equal(evidence.verification_outcome, 'VALID')
  assert.equal(evidence.receipt_reference?.final_root_hex, r.inputs.final_root_hex)
})

test('canonical Merkle path (leaf index 2 / V3) reconstructs the published root', () => {
  const artifact: MerklePathArtifact = {
    type: 'merkle_path',
    leaf_hash_hex: cc.leaf_versions.find((l: { version: string }) => l.version === 'V3').hash_hex,
    path: cc.merkle.path_for_index_2,
    claimed_root_hex: cc.merkle.root_hex,
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'VALID')
})

// ---------------------------------------------------------------------
// Negative / rejection vectors -- each mirrors one entry in
// corpus.negative_cases, verified fail-closed.
// ---------------------------------------------------------------------

test('unknown leaf version tag fails closed (mirrors negative_cases: unknown_leaf_enum)', () => {
  const inputs = cc.leaf_inputs
  const artifact: LeafArtifact = {
    type: 'leaf',
    version: 'V9', // not in the defined V0-V3 set
    claimed_hash_hex: cc.leaf_versions[0].hash_hex,
    channel_id_hex: inputs.channel_id_hex,
    turn_index: inputs.turn_index,
    h_in_hex: inputs.h_in_hex,
    h_out_hex: inputs.h_out_hex,
    g_n: inputs.g_n,
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'INVALID')
  assert.match(r.message, /unknown leaf version/)
})

test('V3 fields on a leaf tagged V2 fail closed (mirrors negative_cases: wrong_leaf_version)', () => {
  const inputs = cc.leaf_inputs
  const artifact: LeafArtifact = {
    type: 'leaf',
    version: 'V2',
    claimed_hash_hex: cc.leaf_versions.find((l: { version: string }) => l.version === 'V2').hash_hex,
    channel_id_hex: inputs.channel_id_hex,
    turn_index: inputs.turn_index,
    h_in_hex: inputs.h_in_hex,
    h_out_hex: inputs.h_out_hex,
    g_n: inputs.g_n,
    miner_recv_ms: inputs.miner_recv_ms,
    miner_done_ms: inputs.miner_done_ms,
    latency_ms: inputs.latency_ms,
    decode_policy_hash_hex: inputs.decode_policy_hash_hex,
    h_ids_hex: inputs.h_ids_hex, // V3-only field present on a V2-tagged leaf
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'INVALID')
  assert.match(r.message, /inconsistent with its declared version/)
})

test('flipped receipt signature byte fails closed (mirrors negative_cases: invalid_receipt_signature)', () => {
  const r = cc.receipt
  // Any single flipped byte in a 64-byte sr25519 signature must reject --
  // whether the library reports a clean "does not verify" or throws on an
  // internally-inconsistent point/scalar (e.g. a non-canonical byte
  // pattern) is an implementation-path detail; both are correctly INVALID,
  // so the test asserts the state, not one specific rejection message.
  const flipped = flipHexByteAt(r.signature_hex, 10)
  const artifact: ReceiptArtifact = {
    type: 'receipt',
    channel_id_hex: r.inputs.channel_id_hex,
    final_root_hex: r.inputs.final_root_hex,
    aggregate_gn: r.inputs.aggregate_gn,
    payable: r.inputs.payable,
    signature_hex: flipped,
    public_key_hex: r.public_key_hex,
  }
  const result = verifyFlopArtifact(artifact)
  assert.equal(result.state, 'INVALID')
  assert.ok(result.failed_checks.length > 0)
})

test('flipped Merkle path orientation fails closed (mirrors negative_cases: wrong_path_orientation)', () => {
  // Flip step 1 (sibling = N0, the level-1 sibling), not step 0: step 0's
  // sibling is the leaf's own duplicate (the odd-node-duplication case), so
  // node(X,X) is orientation-invariant there and flipping it is a no-op --
  // not a meaningful negative case. Step 1's sibling is a genuinely
  // different value, so flipping its orientation changes the root.
  const flippedPath = cc.merkle.path_for_index_2.map((step: { sibling_hex: string; sibling_is_left: boolean }, i: number) =>
    i === 1 ? { ...step, sibling_is_left: !step.sibling_is_left } : step
  )
  const artifact: MerklePathArtifact = {
    type: 'merkle_path',
    leaf_hash_hex: cc.leaf_versions.find((l: { version: string }) => l.version === 'V3').hash_hex,
    path: flippedPath,
    claimed_root_hex: cc.merkle.root_hex,
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'INVALID')
})

test('changed genesis_hash yields a different channel_id, correctly rejecting the original claim (mirrors negative_cases: wrong_genesis_network)', () => {
  const inputs = cc.channel_id.inputs
  const artifact: ChannelIdArtifact = {
    type: 'channel_id',
    claimed_channel_id_hex: cc.channel_id.hash_hex, // the ORIGINAL claimed id
    genesis_hash_hex: flipHexByteAt(inputs.genesis_hash_hex, 0), // but a DIFFERENT genesis
    agent_account_id32_hex: inputs.agent_account_id32_hex,
    miner_account_id32_hex: inputs.miner_account_id32_hex,
    nonce: inputs.nonce,
  }
  const r = verifyFlopArtifact(artifact)
  assert.equal(r.state, 'INVALID')
  assert.match(r.message, /mismatch/)
})

test('unsupported artifact type is UNVERIFIABLE, not silently accepted', () => {
  // @ts-expect-error -- deliberately outside the FlopArtifact union
  const r = verifyFlopArtifact({ type: 'validator_attestation' })
  assert.equal(r.state, 'UNVERIFIABLE')
})

function flipHexByteAt(hex: string, byteIndex: number): string {
  const start = byteIndex * 2
  const byte = parseInt(hex.slice(start, start + 2), 16)
  const flipped = (byte ^ 0xff).toString(16).padStart(2, '0')
  return hex.slice(0, start) + flipped + hex.slice(start + 2)
}
