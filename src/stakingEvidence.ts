/** Signed portable Lido submit artifacts and deterministic reconciliation (D3.6D). */
import { createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { attest, type SignedEnvelope } from './attest.js'
import { contentId, fetchAttestationKeyRegistry, receiptAttestationSigningInput, type ReceiptVerificationState } from './receipts.js'
import { STAKING_ACTION_SCHEMA, STAKING_ATTESTATION_PURPOSE, generateStakingOperationId, type StakingAction, type StakingCheck, type StakingDecisionResult, type StakingPolicy } from './staking.js'
import type { StakingObservation } from './stakingObservation.js'
import type { TaxonomyFinding } from './contradictionTaxonomy.js'

export interface StakingPreflightArtifact {
  schema: typeof STAKING_ACTION_SCHEMA; artifact_type: 'PREFLIGHT'; artifact_digest: string; operation_id: string; created_at: string
  authorized: { action: StakingAction; policy: StakingPolicy; decision: StakingDecisionResult; checks: StakingCheck[] }
  limitations: string[]
}
export interface StakingObservationArtifact {
  schema: typeof STAKING_ACTION_SCHEMA; artifact_type: 'OBSERVATION'; artifact_digest: string; operation_id: string; preflight_artifact_digest: string; observed_at: string
  authorized: { action: StakingAction; policy: StakingPolicy; decision: StakingDecisionResult }
  observed: StakingObservation; reconciliation: TaxonomyFinding[]; limitations: string[]
}
const withDigest = <T extends Record<string, unknown>>(core: T): T & { artifact_digest: string } => ({ ...core, artifact_digest: contentId(core) })
const limitations = [
  'This confirms only the observed Lido submission transaction, not current stETH value, yield, APY, economic safety, slashing risk, peg risk, or smart-contract risk.',
  'This action does not cover withdrawal, unstake, or claim flows.',
  'Minted shares and deposited ETH are different accounting quantities; shares_minted is corroborating evidence and is never compared numerically to the ETH deposit amount.',
]

export async function signStakingPreflight(params: { action: StakingAction; policy: StakingPolicy; decision: StakingDecisionResult; checks: StakingCheck[]; operation_id?: string; created_at?: string }): Promise<SignedEnvelope<StakingPreflightArtifact>> {
  return attest(withDigest({ schema: STAKING_ACTION_SCHEMA, artifact_type: 'PREFLIGHT' as const, operation_id: params.operation_id ?? generateStakingOperationId(), created_at: params.created_at ?? new Date().toISOString(), authorized: { action: params.action, policy: params.policy, decision: params.decision, checks: params.checks }, limitations }), { purpose: STAKING_ATTESTATION_PURPOSE }) as Promise<SignedEnvelope<StakingPreflightArtifact>>
}

export function deriveStakingFindings(action: StakingAction, observation: StakingObservation): TaxonomyFinding[] {
  const refs = observation.log_index === null ? [] : [`${observation.transaction_hash}:${observation.log_index}`]
  const finding = (finding_class: TaxonomyFinding['finding_class'], code: TaxonomyFinding['code'], expected: unknown, observed: unknown, explanation: string): TaxonomyFinding => ({ finding_class, code, expected, observed, evidence_refs: refs, evidence_sources: ['MANDATE', 'CHAIN_OBSERVATION'], explanation })
  if (observation.state !== 'success' || observation.finality?.state !== 'safe') return [finding('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', { transaction_hash: observation.transaction_hash }, { state: observation.state, finality: observation.finality?.state ?? null }, 'The Lido submission lacks independently finalized, internally consistent Submitted evidence.')]
  const output: TaxonomyFinding[] = []
  if (observation.submitted_sender?.toLowerCase() !== action.staker) output.push(finding('CONTRADICTION', 'STAKER_MISMATCH', action.staker, observation.submitted_sender, 'Independently observed Lido Submitted sender differs from the authorized staker.'))
  if (observation.submitted_amount_wei === null || BigInt(observation.submitted_amount_wei) > BigInt(action.max_amount_wei)) output.push(finding('CONTRADICTION', 'AMOUNT_MISMATCH', action.max_amount_wei, observation.submitted_amount_wei, 'Independently observed Lido Submitted amount exceeds the authorized maximum.'))
  return output.sort((left, right) => left.code.localeCompare(right.code))
}

export async function signStakingObservation(preflight: StakingPreflightArtifact, observed: StakingObservation): Promise<SignedEnvelope<StakingObservationArtifact>> {
  return attest(withDigest({ schema: STAKING_ACTION_SCHEMA, artifact_type: 'OBSERVATION' as const, operation_id: preflight.operation_id, preflight_artifact_digest: preflight.artifact_digest, observed_at: new Date().toISOString(), authorized: { action: preflight.authorized.action, policy: preflight.authorized.policy, decision: preflight.authorized.decision }, observed, reconciliation: deriveStakingFindings(preflight.authorized.action, observed), limitations }), { purpose: STAKING_ATTESTATION_PURPOSE }) as Promise<SignedEnvelope<StakingObservationArtifact>>
}

export async function verifyStakingArtifact(envelope: unknown): Promise<{ state: ReceiptVerificationState; code: string; message: string }> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { state: 'INVALID', code: 'envelope-invalid', message: 'expected a signed staking artifact envelope' }
  const candidate = envelope as SignedEnvelope<Record<string, unknown>>, data = candidate.data as Record<string, unknown>, proof = candidate.attestation
  if (!data || data.schema !== STAKING_ACTION_SCHEMA || typeof data.artifact_digest !== 'string') return { state: 'INVALID', code: 'artifact-schema-invalid', message: 'staking artifact schema or digest is invalid' }
  const { artifact_digest, ...core } = data
  if (contentId(core) !== artifact_digest) return { state: 'INVALID', code: 'artifact-digest-mismatch', message: 'artifact_digest does not match artifact content' }
  if (!proof?.signed || proof.schema_version !== 'onchaindiligence.attestation.v2' || proof.issuer !== 'https://api.onchaindiligence.com' || proof.purpose !== STAKING_ATTESTATION_PURPOSE || proof.algorithm !== 'ed25519' || proof.canonicalization !== 'RFC8785' || !proof.key_id || !proof.issued_at || !proof.signature) return { state: 'INVALID', code: 'proof-invalid', message: 'staking artifact proof metadata is invalid' }
  let keys
  try { keys = await fetchAttestationKeyRegistry() } catch { return { state: 'UNVERIFIABLE', code: 'key-registry-unavailable', message: 'public signing-key registry unavailable' } }
  const key = keys.find((entry) => entry.key_id === proof.key_id)
  if (!key) return { state: 'UNVERIFIABLE', code: 'key-not-trusted', message: 'signing key is absent from the public key registry' }
  if (key.status === 'revoked' || key.status === 'compromised') return { state: 'INVALID', code: `key-${key.status}`, message: `signing key is ${key.status}` }
  const issuedAt = Date.parse(proof.issued_at), validFrom = key.valid_from ? Date.parse(key.valid_from) : NaN, validUntil = key.valid_until ? Date.parse(key.valid_until) : Number.POSITIVE_INFINITY
  if (!key.valid_from || !Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== proof.issued_at || !Number.isFinite(validFrom) || issuedAt < validFrom || issuedAt > validUntil) return { state: 'UNVERIFIABLE', code: 'key-lifecycle-unverifiable', message: 'signing-key lifecycle cannot establish this artifact issuance time' }
  try {
    const input = receiptAttestationSigningInput(data, { issuer: proof.issuer, purpose: proof.purpose, issuedAt: proof.issued_at, keyId: proof.key_id })
    return ed25519Verify(null, Buffer.from(input), createPublicKey(key.public_key_pem), Buffer.from(proof.signature, 'base64url'))
      ? { state: 'VALID', code: 'ok', message: 'staking artifact signature and content verify against the public key registry' }
      : { state: 'INVALID', code: 'signature-invalid', message: 'staking artifact signature is invalid' }
  } catch { return { state: 'INVALID', code: 'signature-invalid', message: 'staking artifact signature could not be verified' } }
}
