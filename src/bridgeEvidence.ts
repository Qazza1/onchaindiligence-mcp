/**
 * Signed portable artifacts and deterministic reconciliation for the D3.6C
 * Circle CCTP V2 Base -> Ethereum bridge action. Mirrors D3.6A/D3.6B's
 * artifact conventions exactly (same digest/attestation/verification
 * shape) but keeps four evidence roles explicitly distinct, since a bridge
 * has two independent chain observations rather than one:
 *
 *   AUTHORIZED         -- action + policy + decision (never chain evidence)
 *   SOURCE OBSERVED     -- independent Base depositForBurn observation
 *   DESTINATION OBSERVED -- independent Ethereum receiveMessage observation
 *   RECONCILIATION      -- deterministic findings comparing the three above
 *
 * This is not Action Receipt v1 and never claims a payment binding level
 * (TRANSFER_MATCH_ONLY / EXECUTOR_CORRELATED / PAYMENT_IDENTITY_LINKED) --
 * those vocabularies describe a single-chain payment's provider-vs-chain
 * relationship, which does not apply to a two-chain message-passing bridge.
 */
import { createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { attest, type SignedEnvelope } from './attest.js'
import { contentId, fetchAttestationKeyRegistry, receiptAttestationSigningInput, type ReceiptVerificationState } from './receipts.js'
import { BRIDGE_ACTION_SCHEMA, BRIDGE_ATTESTATION_PURPOSE, CCTP_DOMAIN_BASE, CCTP_DOMAIN_ETHEREUM, generateBridgeOperationId, type BridgeAction, type BridgeCheck, type BridgeDecisionResult, type BridgePolicy } from './bridge.js'
import type { BridgeDestinationObservation, BridgeSourceObservation } from './bridgeObservation.js'
import type { TaxonomyFinding } from './contradictionTaxonomy.js'

export interface BridgePreflightArtifact {
  schema: typeof BRIDGE_ACTION_SCHEMA
  artifact_type: 'PREFLIGHT'
  artifact_digest: string
  operation_id: string
  created_at: string
  authorized: { action: BridgeAction; policy: BridgePolicy; decision: BridgeDecisionResult; checks: BridgeCheck[] }
  limitations: string[]
}

export interface BridgeObservationArtifact {
  schema: typeof BRIDGE_ACTION_SCHEMA
  artifact_type: 'OBSERVATION'
  artifact_digest: string
  operation_id: string
  preflight_artifact_digest: string
  observed_at: string
  authorized: { action: BridgeAction; policy: BridgePolicy; decision: BridgeDecisionResult }
  source_observed: BridgeSourceObservation | null
  destination_observed: BridgeDestinationObservation | null
  reconciliation: TaxonomyFinding[]
  limitations: string[]
}

export type SignedBridgePreflight = SignedEnvelope<BridgePreflightArtifact>
export type SignedBridgeObservation = SignedEnvelope<BridgeObservationArtifact>

function withDigest<T extends Record<string, unknown>>(core: T): T & { artifact_digest: string } {
  return { ...core, artifact_digest: contentId(core) }
}

export async function signBridgePreflight(params: {
  action: BridgeAction; policy: BridgePolicy; decision: BridgeDecisionResult; checks: BridgeCheck[]; created_at?: string; operation_id?: string
}): Promise<SignedBridgePreflight> {
  const core = {
    schema: BRIDGE_ACTION_SCHEMA,
    artifact_type: 'PREFLIGHT' as const,
    operation_id: params.operation_id ?? generateBridgeOperationId(),
    created_at: params.created_at ?? new Date().toISOString(),
    authorized: { action: params.action, policy: params.policy, decision: params.decision, checks: params.checks },
    limitations: [
      'Policy ALLOW is not wallet authority; OCD does not submit depositForBurn or receiveMessage.',
      'A CCTP attestation from Circle is not required or consulted by this artifact; source and destination are each independently observed on-chain.',
      'This portable bridge artifact is not a Public Action Receipt v1, not a payment record, and never claims a payment binding level.',
    ],
  }
  return attest(withDigest(core), { purpose: BRIDGE_ATTESTATION_PURPOSE }) as Promise<SignedBridgePreflight>
}

/**
 * Deterministic reconciliation (D3.6C, Section 3/9). Never correlates on
 * amount, recipient, or timestamp proximity -- only on the actual CCTP
 * message identity (message body bytes hash, nonce, source/destination
 * domain), the strongest available evidence.
 */
export function deriveBridgeFindings(action: BridgeAction, source: BridgeSourceObservation | null, destination: BridgeDestinationObservation | null): TaxonomyFinding[] {
  const finding = (finding_class: TaxonomyFinding['finding_class'], code: TaxonomyFinding['code'], expected: unknown, observed: unknown, explanation: string, refs: string[] = []): TaxonomyFinding =>
    ({ finding_class, code, expected, observed, evidence_refs: refs, evidence_sources: ['MANDATE', 'CHAIN_OBSERVATION'], explanation })

  const sourceFinal = source?.state === 'success' && source.finality?.state === 'safe'
  const destinationFinal = destination?.state === 'success' && destination.finality?.state === 'safe'

  if (!sourceFinal) {
    return [finding('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', { source_transaction: 'finalized DepositForBurn' }, { state: source?.state ?? null, finality: source?.finality?.state ?? null }, 'The Base CCTP depositForBurn transaction has no independently finalized DepositForBurn/MessageSent observation.')]
  }
  if (!destinationFinal) {
    return [finding('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', { destination_transaction: 'finalized MessageReceived' }, { state: destination?.state ?? null, finality: destination?.finality?.state ?? null }, 'Bridge completion is not independently established: no finalized Ethereum MessageReceived/MintAndWithdraw observation exists for this source message. Source-only observation is never treated as proof of completion.', source ? [`${source.transaction_hash}:${source.log_index}`] : [])]
  }
  // Both sides are independently finalized -- refs from here on cite both transactions.
  const refs = [`${source!.transaction_hash}:${source!.log_index}`, `${destination!.transaction_hash}:${destination!.log_index}`]

  // Strongest identity check first: the message body bytes hash, nonce, and
  // both domains must match exactly. A mismatch here means these two
  // transactions are not proven to be the same CCTP transfer at all --
  // every subsequent field comparison would be meaningless, so this is
  // checked and returned on its own.
  const identityMismatch =
    source!.message_body_hash !== destination!.message_body_hash ||
    source!.nonce !== destination!.nonce ||
    source!.source_domain !== destination!.source_domain ||
    source!.destination_domain !== destination!.destination_domain
  if (identityMismatch) {
    return [finding(
      'CONTRADICTION', 'BRIDGE_MESSAGE_MISMATCH',
      { message_body_hash: source!.message_body_hash, nonce: source!.nonce, source_domain: source!.source_domain, destination_domain: source!.destination_domain },
      { message_body_hash: destination!.message_body_hash, nonce: destination!.nonce, source_domain: destination!.source_domain, destination_domain: destination!.destination_domain },
      'The independently observed CCTP message identity (message body hash, nonce, and domains) differs between the source and destination transactions. These are not proven to be the same bridge transfer.',
      refs,
    )]
  }

  const output: TaxonomyFinding[] = []
  if (source!.source_domain !== CCTP_DOMAIN_BASE || destination!.destination_domain !== CCTP_DOMAIN_ETHEREUM) {
    output.push(finding('CONTRADICTION', 'NETWORK_MISMATCH', { source_domain: CCTP_DOMAIN_BASE, destination_domain: CCTP_DOMAIN_ETHEREUM }, { source_domain: source!.source_domain, destination_domain: destination!.destination_domain }, 'Observed CCTP domains differ from the approved Base(6) -> Ethereum(0) profile.', refs))
  }
  if (destination!.mint_recipient !== action.recipient) {
    output.push(finding('CONTRADICTION', 'RECIPIENT_MISMATCH', action.recipient, destination!.mint_recipient, 'Independently observed destination mint recipient differs from the authorized recipient.', refs))
  }
  if (destination!.mint_amount_atomic === null || BigInt(destination!.mint_amount_atomic) < BigInt(action.min_destination_atomic)) {
    output.push(finding('CONTRADICTION', 'AMOUNT_MISMATCH', action.min_destination_atomic, destination!.mint_amount_atomic, 'Independently observed destination mint amount is below the authorized minimum.', refs))
  }
  return output.sort((a, b) => a.code.localeCompare(b.code))
}

export async function signBridgeObservation(preflight: BridgePreflightArtifact, source: BridgeSourceObservation | null, destination: BridgeDestinationObservation | null): Promise<SignedBridgeObservation> {
  const findings = deriveBridgeFindings(preflight.authorized.action, source, destination)
  const core = {
    schema: BRIDGE_ACTION_SCHEMA,
    artifact_type: 'OBSERVATION' as const,
    operation_id: preflight.operation_id,
    preflight_artifact_digest: preflight.artifact_digest,
    observed_at: new Date().toISOString(),
    authorized: { action: preflight.authorized.action, policy: preflight.authorized.policy, decision: preflight.authorized.decision },
    source_observed: source,
    destination_observed: destination,
    reconciliation: findings,
    limitations: [
      'Source-only observation is never treated as proof that a bridge transfer completed; destination MessageReceived/MintAndWithdraw evidence is required.',
      'Correlation uses only the CCTP message body hash, nonce, and source/destination domain -- never amount, recipient, or timestamp proximity.',
      'A Circle attestation is not consulted; both chains are observed directly against their own RPC.',
      'Payment binding vocabulary (TRANSFER_MATCH_ONLY / EXECUTOR_CORRELATED / PAYMENT_IDENTITY_LINKED) is not applicable to a bridge action.',
    ],
  }
  return attest(withDigest(core), { purpose: BRIDGE_ATTESTATION_PURPOSE }) as Promise<SignedBridgeObservation>
}

export async function verifyBridgeArtifact(envelope: unknown): Promise<{ state: ReceiptVerificationState; code: string; message: string }> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { state: 'INVALID', code: 'envelope-invalid', message: 'expected a signed bridge artifact envelope' }
  const candidate = envelope as SignedEnvelope<Record<string, unknown>>
  const data = candidate.data as Record<string, unknown>
  const proof = candidate.attestation
  if (!data || typeof data !== 'object' || data.schema !== BRIDGE_ACTION_SCHEMA || typeof data.artifact_digest !== 'string') return { state: 'INVALID', code: 'artifact-schema-invalid', message: 'bridge artifact schema or digest is invalid' }
  const { artifact_digest, ...core } = data
  if (contentId(core) !== artifact_digest) return { state: 'INVALID', code: 'artifact-digest-mismatch', message: 'artifact_digest does not match the artifact content' }
  if (!proof?.signed || proof.schema_version !== 'onchaindiligence.attestation.v2' || proof.issuer !== 'https://api.onchaindiligence.com' || proof.purpose !== BRIDGE_ATTESTATION_PURPOSE || proof.algorithm !== 'ed25519' || proof.canonicalization !== 'RFC8785' || !proof.key_id || !proof.issued_at || !proof.signature) return { state: 'INVALID', code: 'proof-invalid', message: 'bridge artifact proof metadata is invalid' }
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
    return valid ? { state: 'VALID', code: 'ok', message: 'bridge artifact signature and content verify against the public key registry' } : { state: 'INVALID', code: 'signature-invalid', message: 'bridge artifact signature is invalid' }
  } catch { return { state: 'INVALID', code: 'signature-invalid', message: 'bridge artifact signature could not be verified' } }
}
