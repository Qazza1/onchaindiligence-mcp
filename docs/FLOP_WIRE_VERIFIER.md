# FLOP Wire / Receipt Conformance Verifier (D3.5D-B)

An **offline** verifier that answers one question: *does this FLOP wire
artifact conform to the currently published normative wire-format rules?*
Nothing else. It is not a FLOP executor, chain watcher, or HTLC
implementation — see [Known unsupported areas](#known-unsupported-areas).

Module: [`src/flopWireVerifier.ts`](../src/flopWireVerifier.ts). Tests:
[`test/flopWireVerifier.test.ts`](../test/flopWireVerifier.test.ts), driven
by the vendored corpus at
[`test/fixtures/flop-wire-format-v1.json`](../test/fixtures/flop-wire-format-v1.json).

## Exact FLOP spec revision supported

- **Spec:** FLOP Yellow Paper **v0.5.0 (draft)** — no version has been
  publicly released; this targets the current draft text.
- **Source repo revision:** `flop-labs/yellowpaper` @
  `cb3cbf97a346ff85aca6dba5e924434270ca672c` (repo HEAD at the time this
  module was written). The wire-format corpus content itself has been
  unchanged since the `2026-09-10` sync commit `3eaf2f25bc46a501df225cae4e4e991975f6b2a9`,
  which is the commit that introduced `evidence/wire-format-v1.json` and
  decision `D-0505` in the first place.
- **Corpus status:** the vendored `evidence/wire-format-v1.json` itself
  declares `"status": "public-canonical"`.

## What VALID means

The artifact's structure, hash, and/or signature checked out against the
exact byte-level rules in Appendix F ("Message & Storage Formats") of the
spec revision above.

## What VALID does NOT mean

Per D-0505 §12.1's own wording ("these signatures prove agreement on a
receipt and sum; they do not prove that the output resulted from the
claimed execution"), VALID here never means:

- inference output was correct
- GPU work actually occurred
- output quality was good
- settlement occurred on-chain
- an HTLC pair completed
- any service was delivered

These are runtime/settlement claims. This module only checks that a
caller-supplied artifact is *internally consistent with itself* under
FLOP's published wire rules — the same distinction OCD already draws
between a receipt's cryptographic proof and the real-world claims it
carries (see the main OCD README's claim-discipline section).

## Supported artifact types

| `artifact_type` | Appendix F reference | Checks performed |
|---|---|---|
| `channel_id` | F.1 | recomputes `blake2_256("FLOP/COMPUTE_CHANNEL/ID" ‖ 01 ‖ genesis_hash ‖ agent ‖ miner ‖ nonce:u64LE)`, compares to the claimed id |
| `leaf` | F.3 | validates the version tag is V0–V3; validates field presence matches that version (F.3's `LeafFieldsInconsistent` rule); reconstructs the version-specific preimage; recomputes `blake2_256`, compares to the claimed hash |
| `receipt` | F.3 | reconstructs `"FLOP/COMPUTE_CHANNEL/RECEIPT" ‖ 01 ‖ channel_id ‖ final_root ‖ aggregate_gn:u128LE ‖ payable:u128LE`; verifies the sr25519/Schnorrkel signature against the supplied public key |
| `merkle_path` | F.3 | replays the supplied `(sibling, sibling_is_left)` path from a leaf hash (`blake2_256(left‖right)` per node, no prefix); compares the reconstructed root to the claimed root |

## Verification algorithm (per artifact type)

Every check is pure and synchronous: parse/validate fixed-width hex inputs
→ reconstruct the exact byte preimage Appendix F specifies → recompute a
hash or verify a signature → compare against the caller's claim. No field
is ever accepted by type coercion, truncation, or partial match — matches
F.0's own codec rule ("no saturation, truncation, floating-point
conversion, or rounding is permitted").

## Result model

Reuses OCD's own existing tri-state verification vocabulary
(`receipts.ts`'s `ReceiptVerificationState`) rather than inventing a new
one:

```ts
interface FlopVerificationResult {
  state: 'VALID' | 'INVALID' | 'UNVERIFIABLE'
  protocol: 'flop'
  spec_version: string        // 'v0.5.0 (draft)'
  spec_revision: string       // the pinned yellowpaper commit SHA above
  artifact_type: 'channel_id' | 'leaf' | 'receipt' | 'merkle_path'
  verified_checks: string[]   // what specifically passed
  failed_checks: string[]     // what specifically failed
  unknowns: string[]          // e.g. an unsupported artifact_type
  message: string
}
```

`UNVERIFIABLE` is reserved for a request this verifier slice structurally
cannot attempt (an unsupported `artifact_type`) — never for a malformed or
inconsistent field, which is always `INVALID` (fail-closed).

## Fail-closed behavior

Per F.0's own rejection profile:

- An unknown leaf version tag (anything outside V0–V3) is **INVALID**, not
  `UNVERIFIABLE` — F.0: "unknown tags... MUST be rejected."
- A leaf whose field presence doesn't match its declared version (e.g. V3
  fields present on a V2-tagged leaf) is **INVALID** — this is exactly
  F.3's `LeafFieldsInconsistent` rejection, and the specific case the
  corpus's `wrong_leaf_version` negative fixture exercises.
- Malformed hex (wrong length, non-hex characters), a negative or
  out-of-range integer, or a signature/public key of the wrong byte length
  are all **INVALID**, never silently coerced or truncated.
- A signature that fails to verify is **INVALID**, whether the underlying
  library returns a clean `false` or throws on an internally-inconsistent
  point/scalar encoding — both paths are treated as fail-closed rejection.

## OCD evidence normalization

`normalizeFlopArtifactEvidence(artifact, result)` produces a summary
explicitly tagged `evidence_class: 'artifact-structure-only'` — it
preserves spec version/revision, `channel_id`, `leaf_version`, participant
account IDs (where the artifact type carries them), the receipt reference
(`final_root`/`aggregate_gn`/`payable`), and which fields were
cryptographically checked. It **does not** claim `task_hash` coverage (not
implemented this slice — see below) and is never to be presented as
independently-observed settlement evidence; that distinction is the whole
point of D3.5D-C being a separate future milestone.

## Known unsupported / pending FLOP areas

Deliberately out of scope for this slice, not overlooked:

- **`task_hash` v1 / direct-rail `ValidatorAttestation`** (F.1, F.2) — same
  hash/signature primitives this module already proves correct, but not
  wired up as a fifth artifact type yet. Natural next extension, not
  attempted here to keep this slice small.
- **`decode_policy_hash`, `report_data`** (F.1) — use SHA256, not
  blake2_256; no SHA256 dependency is imported in this module because
  nothing here needs it yet.
- **FCC4 transcript container decode** (F.3) — full-container
  parsing/version-consistency (`unknown_fcc_version`, `truncated_fcc4`,
  `trailing_fcc4` negative cases) is not implemented; this module verifies
  individual leaves and paths, not the wrapping container.
- **`ChannelWireProfiles`/`ChannelDecodePolicies` cutoff-marker state**
  (F.3's accepted-version cutoff) — whether a given channel's *on-chain
  marker* permits a legacy V0/V1 leaf is channel state this offline
  verifier cannot know without watching the chain (explicitly out of scope
  for this milestone). The corpus's `legacy_leaf_current_channel` and
  `legacy_receipt_current_channel` negative cases depend on this state and
  are not exercised here for that reason.
- **HTLC** (§10) — cross-chain pair qualification is `E.48 [TBD]` in the
  spec itself; nothing to verify yet by FLOP's own admission. D3.5D-D.
- **Settlement/chain observation** — D3.5D-C. This module never queries a
  chain.

## How to update fixtures when FLOP publishes a new canonical corpus

1. `git clone flop-labs/yellowpaper` fresh, `git rev-parse HEAD`.
2. `diff` the new `evidence/wire-format-v1.json` against
   `test/fixtures/flop-wire-format-v1.json` — if the `status` field is no
   longer `"public-canonical"` or the schema changed shape, stop and review
   Appendix F's diff before touching code.
3. Copy the new `evidence/wire-format-v1.json` and
   `evidence/wire-format-v1.schema.json` over the vendored copies.
4. Update `FLOP_SPEC_REVISION` (and `FLOP_SPEC_VERSION` if the paper itself
   was versioned/released) in `src/flopWireVerifier.ts`.
5. Run `node --import tsx --test test/flopWireVerifier.test.ts` — every
   canonical/negative case is read from the fixture at test time, so a
   genuine wire-format change will surface as a real test failure, not a
   silent pass.
