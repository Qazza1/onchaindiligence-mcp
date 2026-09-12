import { createPublicKey, verify as verifyEd25519 } from 'node:crypto'
import { attest, type SignedEnvelope } from './attest.js'
import { contentId, fetchAttestationKeyRegistry, receiptAttestationSigningInput, type ReceiptVerificationState } from './receipts.js'
import { SWAP_ACTION_SCHEMA, SWAP_ATTESTATION_PURPOSE, generateSwapOperationId, type SwapAction, type SwapCheck, type SwapDecisionResult, type SwapPolicy } from './swap.js'
import type { SwapObservation } from './swapObservation.js'
import type { FindingClass, TaxonomyFinding, TaxonomyFindingCode } from './contradictionTaxonomy.js'

export interface SwapPreflightArtifact {
  schema: typeof SWAP_ACTION_SCHEMA; artifact_type: 'PREFLIGHT'; artifact_digest: string; operation_id: string; created_at: string
  action: SwapAction; policy: SwapPolicy; decision: SwapDecisionResult; checks: SwapCheck[]; limitations: string[]
}
export interface SwapObservationArtifact {
  schema: typeof SWAP_ACTION_SCHEMA; artifact_type: 'OBSERVATION'; artifact_digest: string; operation_id: string; preflight_artifact_digest: string; observed_at: string
  action: SwapAction; observation: SwapObservation; findings: TaxonomyFinding[]; limitations: string[]
}
type SwapArtifact = SwapPreflightArtifact | SwapObservationArtifact

function withDigest<T extends Record<string, unknown>>(artifact: T): T & { artifact_digest: string } {
  return { ...artifact, artifact_digest: contentId(artifact) }
}

export const signSwapPreflight = (input: { action: SwapAction; policy: SwapPolicy; decision: SwapDecisionResult; checks: SwapCheck[]; created_at?: string; operation_id?: string }) =>
  attest(withDigest({
    schema: SWAP_ACTION_SCHEMA, artifact_type: 'PREFLIGHT' as const, operation_id: input.operation_id ?? generateSwapOperationId(), created_at: input.created_at ?? new Date().toISOString(),
    action: input.action, policy: input.policy, decision: input.decision, checks: input.checks,
    limitations: ['Policy ALLOW is not wallet authority and OCD does not execute a swap.', 'This is a portable swap artifact, not an Action Receipt v1 or payment record.'],
  }), { purpose: SWAP_ATTESTATION_PURPOSE }) as Promise<SignedEnvelope<SwapPreflightArtifact>>

function finding(findingClass: FindingClass, code: TaxonomyFindingCode, expected: unknown, observed: unknown, evidenceRefs: string[], explanation: string): TaxonomyFinding {
  return { finding_class: findingClass, code, expected, observed, evidence_refs: evidenceRefs, evidence_sources: ['MANDATE', 'CHAIN_OBSERVATION'], explanation }
}

export function deriveSwapFindings(action: SwapAction, observation: SwapObservation): TaxonomyFinding[] {
  const evidenceRefs = observation.input_transfer ? [`${observation.input_transfer.transaction_hash}:${observation.input_transfer.log_index}`] : []
  if (observation.state !== 'success' || observation.finality?.state !== 'safe') {
    return [finding('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', { transaction_hash: observation.transaction_hash }, { state: observation.state, finality: observation.finality?.state ?? null }, evidenceRefs, 'Submitted swap has no independently finalized supported swap evidence.')]
  }
  const findings: TaxonomyFinding[] = []
  if (observation.router !== action.router) findings.push(finding('CONTRADICTION', 'ROUTER_MISMATCH', action.router, observation.router, evidenceRefs, 'Authorized router and transaction executor differ.'))
  if (!observation.decoded_parameters || observation.decoded_parameters.input_asset.toLowerCase() !== action.input_asset) findings.push(finding('CONTRADICTION', 'ASSET_MISMATCH', action.input_asset, observation.decoded_parameters?.input_asset ?? null, evidenceRefs, 'Authorized input asset and decoded router input asset differ.'))
  if (!observation.decoded_parameters || observation.decoded_parameters.output_asset.toLowerCase() !== action.output_asset) findings.push(finding('CONTRADICTION', 'OUTPUT_ASSET_MISMATCH', action.output_asset, observation.decoded_parameters?.output_asset ?? null, evidenceRefs, 'Authorized output asset and decoded router output asset differ.'))
  if (!observation.decoded_parameters || observation.decoded_parameters.recipient.toLowerCase() !== action.recipient) findings.push(finding('CONTRADICTION', 'RECIPIENT_MISMATCH', action.recipient, observation.decoded_parameters?.recipient ?? null, evidenceRefs, 'Authorized recipient and decoded router recipient differ.'))
  if (!observation.input_transfer || BigInt(observation.input_transfer.amount_atomic) > BigInt(action.max_input_atomic)) findings.push(finding('CONTRADICTION', 'AMOUNT_MISMATCH', action.max_input_atomic, observation.input_transfer?.amount_atomic ?? null, evidenceRefs, 'Observed input exceeds the authorized maximum.'))
  if (!observation.output_transfer || BigInt(observation.output_transfer.amount_atomic) < BigInt(action.min_output_atomic)) findings.push(finding('CONTRADICTION', 'MINIMUM_OUTPUT_NOT_MET', action.min_output_atomic, observation.output_transfer?.amount_atomic ?? null, evidenceRefs, 'Observed output is below the authorized minimum.'))
  return findings.sort((left, right) => left.code.localeCompare(right.code))
}

export const signSwapObservation = (preflight: SwapPreflightArtifact, observation: SwapObservation) =>
  attest(withDigest({
    schema: SWAP_ACTION_SCHEMA, artifact_type: 'OBSERVATION' as const, operation_id: preflight.operation_id, preflight_artifact_digest: preflight.artifact_digest, observed_at: new Date().toISOString(),
    action: preflight.action, observation, findings: deriveSwapFindings(preflight.action, observation),
    limitations: ['Chain observation establishes a narrow direct-router transfer profile, not price fairness, service delivery, or objective safety.', 'Payment binding vocabulary is not applicable to a swap action.'],
  }), { purpose: SWAP_ATTESTATION_PURPOSE }) as Promise<SignedEnvelope<SwapObservationArtifact>>

export async function verifySwapArtifact(envelope: unknown): Promise<{ state: ReceiptVerificationState; code: string; message: string }> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { state: 'INVALID', code: 'envelope-invalid', message: 'expected a signed swap artifact envelope' }
  const parsed = envelope as SignedEnvelope<SwapArtifact>
  const artifact = parsed.data
  const proof = parsed.attestation
  if (!artifact || artifact.schema !== SWAP_ACTION_SCHEMA || typeof artifact.artifact_digest !== 'string') return { state: 'INVALID', code: 'artifact-schema-invalid', message: 'swap artifact schema or digest is invalid' }
  const { artifact_digest, ...unsignedArtifact } = artifact
  if (contentId(unsignedArtifact) !== artifact_digest) return { state: 'INVALID', code: 'artifact-digest-mismatch', message: 'artifact digest does not match content' }
  if (!proof?.signed || proof.purpose !== SWAP_ATTESTATION_PURPOSE || proof.algorithm !== 'ed25519' || proof.canonicalization !== 'RFC8785' || !proof.key_id || !proof.issued_at || !proof.signature) return { state: 'INVALID', code: 'proof-invalid', message: 'swap artifact proof metadata is invalid' }
  let keys
  try { keys = await fetchAttestationKeyRegistry() } catch { return { state: 'UNVERIFIABLE', code: 'key-registry-unavailable', message: 'public signing-key registry unavailable' } }
  const key = keys.find((candidate) => candidate.key_id === proof.key_id)
  if (!key) return { state: 'UNVERIFIABLE', code: 'key-not-trusted', message: 'signing key absent from registry' }
  if (key.status === 'revoked' || key.status === 'compromised') return { state: 'INVALID', code: `key-${key.status}`, message: `signing key is ${key.status}` }
  try {
    const valid = verifyEd25519(null, Buffer.from(receiptAttestationSigningInput(artifact, { issuer: proof.issuer!, purpose: proof.purpose!, issuedAt: proof.issued_at!, keyId: proof.key_id! })), createPublicKey(key.public_key_pem), Buffer.from(proof.signature, 'base64url'))
    return valid ? { state: 'VALID', code: 'ok', message: 'swap artifact signature and content verify against public key registry' } : { state: 'INVALID', code: 'signature-invalid', message: 'swap artifact signature is invalid' }
  } catch { return { state: 'INVALID', code: 'signature-invalid', message: 'swap artifact signature could not be verified' } }
}
