/** Signed portable artifacts and deterministic reconciliation for D3.6A. */
import { createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { attest, type SignedEnvelope } from './attest.js'
import { contentId, fetchAttestationKeyRegistry, receiptAttestationSigningInput, type ReceiptVerificationState } from './receipts.js'
import { ERC20_ALLOWANCE_ACTION_SCHEMA, ERC20_ALLOWANCE_ATTESTATION_PURPOSE, generateAllowanceOperationId, type AllowanceAction, type AllowanceCheck, type AllowanceDecisionResult, type AllowancePolicy } from './allowance.js'
import type { AllowanceObservation, ApprovalEvent } from './allowanceObservation.js'
import type { TaxonomyFinding } from './contradictionTaxonomy.js'

export interface AllowancePreflightArtifact {
  schema: typeof ERC20_ALLOWANCE_ACTION_SCHEMA
  artifact_type: 'PREFLIGHT'
  artifact_digest: string
  operation_id: string
  created_at: string
  action: AllowanceAction
  policy: AllowancePolicy
  decision: AllowanceDecisionResult
  checks: AllowanceCheck[]
  pre_action_state: unknown
  limitations: string[]
}
export interface AllowanceObservationArtifact {
  schema: typeof ERC20_ALLOWANCE_ACTION_SCHEMA
  artifact_type: 'OBSERVATION'
  artifact_digest: string
  operation_id: string
  preflight_artifact_digest: string
  observed_at: string
  action: AllowanceAction
  observation: AllowanceObservation
  selected_approval: ApprovalEvent | null
  findings: TaxonomyFinding[]
  limitations: string[]
}
export type SignedAllowancePreflight = SignedEnvelope<AllowancePreflightArtifact>
export type SignedAllowanceObservation = SignedEnvelope<AllowanceObservationArtifact>

function withDigest<T extends Record<string, unknown>>(core: T): T & { artifact_digest: string } {
  return { ...core, artifact_digest: contentId(core) }
}

export async function signAllowancePreflight(params: {
  action: AllowanceAction; policy: AllowancePolicy; decision: AllowanceDecisionResult; checks: AllowanceCheck[]; pre_action_state: unknown; created_at?: string; operation_id?: string
}): Promise<SignedAllowancePreflight> {
  const core = {
    schema: ERC20_ALLOWANCE_ACTION_SCHEMA,
    artifact_type: 'PREFLIGHT' as const,
    operation_id: params.operation_id ?? generateAllowanceOperationId(),
    created_at: params.created_at ?? new Date().toISOString(),
    action: params.action,
    policy: params.policy,
    decision: params.decision,
    checks: params.checks,
    pre_action_state: params.pre_action_state,
    limitations: [
      'Policy ALLOW is not wallet authority and OCD does not execute approve().',
      'Pre-action allowance state, when present, is an independent point-in-time read and is not execution evidence.',
      'This portable allowance artifact is not a Public Action Receipt v1 and is not a payment record.',
    ],
  }
  return attest(withDigest(core), { purpose: ERC20_ALLOWANCE_ATTESTATION_PURPOSE }) as Promise<SignedAllowancePreflight>
}

export function selectMatchingApproval(action: AllowanceAction, observation: AllowanceObservation): ApprovalEvent | null {
  const owner = action.owner?.toLowerCase()
  // Select a single deterministic candidate for reconciliation. Prefer the
  // authorized owner so a wrong spender/value is visible as a contradiction;
  // never select by value (that would hide an allowance mismatch).
  return observation.approvals.find((approval) => owner !== null && owner !== undefined && approval.owner.toLowerCase() === owner)
    ?? (owner === null || owner === undefined ? observation.approvals[0] ?? null : null)
}

export function deriveAllowanceFindings(action: AllowanceAction, observation: AllowanceObservation, selected: ApprovalEvent | null): TaxonomyFinding[] {
  const refs = selected ? [`${selected.transaction_hash}:${selected.log_index}`] : []
  const base = (finding_class: TaxonomyFinding['finding_class'], code: TaxonomyFinding['code'], expected: unknown, observed: unknown, explanation: string): TaxonomyFinding => ({ finding_class, code, expected, observed, evidence_refs: refs, evidence_sources: ['MANDATE', 'CHAIN_OBSERVATION'], explanation })
  if (observation.state !== 'success' || observation.finality?.state !== 'safe') {
    return [base('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', { transaction_hash: observation.transaction_hash }, { state: observation.state, finality: observation.finality?.state ?? null }, 'Submitted allowance transaction has no independently finalized Approval observation.')]
  }
  if (!selected) return [base('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', { owner: action.owner, spender: action.spender, value_atomic: action.amount_atomic }, { approvals: observation.approvals.length }, 'No attributable canonical-USDC Approval event was observed in the finalized transaction.')]
  const output: TaxonomyFinding[] = []
  if (selected.spender.toLowerCase() !== action.spender) output.push(base('CONTRADICTION', 'SPENDER_MISMATCH', action.spender, selected.spender, 'Authorized spender and independently observed Approval spender differ.'))
  if (selected.value_atomic !== action.amount_atomic) output.push(base('CONTRADICTION', 'ALLOWANCE_MISMATCH', action.amount_atomic, selected.value_atomic, 'Authorized allowance value and independently observed Approval value differ.'))
  if (action.owner && selected.owner.toLowerCase() !== action.owner) output.push(base('CONTRADICTION', 'REQUIRED_EVIDENCE_MISSING', action.owner, selected.owner, 'Approval owner cannot be attributed to the authorized owner.'))
  if (observation.post_state?.state === 'OBSERVED' && observation.post_state.value_atomic !== selected.value_atomic) output.push(base('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', { approval_value_atomic: selected.value_atomic }, { historical_post_state_atomic: observation.post_state.value_atomic }, 'Historical allowance state at the transaction block differs from its Approval event; no contradiction is inferred without token-specific temporal context.'))
  return output.sort((a, b) => a.code.localeCompare(b.code))
}

export async function signAllowanceObservation(preflight: AllowancePreflightArtifact, observation: AllowanceObservation): Promise<SignedAllowanceObservation> {
  const selected = selectMatchingApproval(preflight.action, observation)
  const findings = deriveAllowanceFindings(preflight.action, observation, selected)
  const core = {
    schema: ERC20_ALLOWANCE_ACTION_SCHEMA,
    artifact_type: 'OBSERVATION' as const,
    operation_id: preflight.operation_id,
    preflight_artifact_digest: preflight.artifact_digest,
    observed_at: new Date().toISOString(),
    action: preflight.action,
    observation,
    selected_approval: selected,
    findings,
    limitations: [
      'Approval proves the token contract emitted the event in a successful transaction; it does not prove a service, trade, or later spender behavior.',
      'Post-state is a historical read at the target block when available and remains distinct from the Approval event.',
      'Payment binding vocabulary is not applicable to an allowance action.',
    ],
  }
  return attest(withDigest(core), { purpose: ERC20_ALLOWANCE_ATTESTATION_PURPOSE }) as Promise<SignedAllowanceObservation>
}

export async function verifyAllowanceArtifact(envelope: unknown): Promise<{ state: ReceiptVerificationState; code: string; message: string }> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { state: 'INVALID', code: 'envelope-invalid', message: 'expected a signed allowance artifact envelope' }
  const candidate = envelope as SignedEnvelope<Record<string, unknown>>
  const data = candidate.data as Record<string, unknown>
  const proof = candidate.attestation
  if (!data || typeof data !== 'object' || data.schema !== ERC20_ALLOWANCE_ACTION_SCHEMA || typeof data.artifact_digest !== 'string') return { state: 'INVALID', code: 'artifact-schema-invalid', message: 'allowance artifact schema or digest is invalid' }
  const { artifact_digest, ...core } = data
  if (contentId(core) !== artifact_digest) return { state: 'INVALID', code: 'artifact-digest-mismatch', message: 'artifact_digest does not match the artifact content' }
  if (!proof?.signed || proof.schema_version !== 'onchaindiligence.attestation.v2' || proof.issuer !== 'https://api.onchaindiligence.com' || proof.purpose !== ERC20_ALLOWANCE_ATTESTATION_PURPOSE || proof.algorithm !== 'ed25519' || proof.canonicalization !== 'RFC8785' || !proof.key_id || !proof.issued_at || !proof.signature) return { state: 'INVALID', code: 'proof-invalid', message: 'allowance artifact proof metadata is invalid' }
  let registry
  try { registry = await fetchAttestationKeyRegistry() } catch { return { state: 'UNVERIFIABLE', code: 'key-registry-unavailable', message: 'the public signing-key registry could not be reached' } }
  const key = registry.find((entry) => entry.key_id === proof.key_id)
  if (!key) return { state: 'UNVERIFIABLE', code: 'key-not-trusted', message: 'signing key is absent from the public key registry' }
  if (key.status === 'revoked' || key.status === 'compromised') return { state: 'INVALID', code: `key-${key.status}`, message: `signing key is ${key.status}` }
  const issuedAt = Date.parse(proof.issued_at)
  const validFrom = key.valid_from ? Date.parse(key.valid_from) : NaN
  const validUntil = key.valid_until ? Date.parse(key.valid_until) : Number.POSITIVE_INFINITY
  if (!key.valid_from || !Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== proof.issued_at || !Number.isFinite(validFrom) || issuedAt < validFrom || issuedAt > validUntil) {
    return { state: 'UNVERIFIABLE', code: 'key-lifecycle-unverifiable', message: 'signing key lifecycle boundaries cannot establish this artifact issuance time' }
  }
  try {
    const signingInput = receiptAttestationSigningInput(data, { issuer: proof.issuer, purpose: proof.purpose, issuedAt: proof.issued_at, keyId: proof.key_id })
    const valid = ed25519Verify(null, Buffer.from(signingInput), createPublicKey(key.public_key_pem), Buffer.from(proof.signature, 'base64url'))
    return valid ? { state: 'VALID', code: 'ok', message: 'allowance artifact signature and content verify against the public key registry' } : { state: 'INVALID', code: 'signature-invalid', message: 'allowance artifact signature is invalid' }
  } catch { return { state: 'INVALID', code: 'signature-invalid', message: 'allowance artifact signature could not be verified' } }
}
