/**
 * commerceLifecycle.ts — the onchaindiligence.commerce-lifecycle.v1 profile
 * (D2.4, Section 1) and the three-level binding-strength claim model
 * (D2.4, Claim Model).
 *
 * ARCHITECTURE: this profile is PRIVATE evidence, not a new receipt type and
 * not a v2 receipt schema — Public Action Receipt v1 is unchanged (see
 * receipts.ts) and legacy receipts without this profile remain valid
 * historical receipts whose action binding is simply "not recorded", never
 * upgraded or weakened. A commerce-lifecycle bundle is a canonical JSON
 * document (content-addressed with the EXACT SAME algorithm as
 * receipts.ts's contentId/canonicalizeJson — verified interoperable with
 * packages/agent-evidence's own canonical.ts) whose digest is meant to be
 * carried in a receipt's existing `links.agent_evidence_bundle_digest`
 * field and/or as a check's `evidence_digest` — the existing extension
 * points named in the receipt schema, reused rather than replaced.
 *
 * This intentionally does NOT reimplement the full Agent Evidence DSSE
 * envelope / record-graph machinery (packages/agent-evidence's
 * BundlePayload/AgentEvidenceRecord types) — that already-signed, full
 * bundle format is a different, heavier mechanism this deployment never
 * uses today (every existing receipt's `agent_evidence_bundle_digest` is
 * null), and reproducing it here for one internal profile would be exactly
 * the "entire Integration Kit" scope explicitly out of bounds for D2.4. The
 * `extensions: JsonObject` field on that format IS the sanctioned place a
 * profile like this belongs when/if a full signed bundle is built (D2.5's
 * adapter can do that); this module produces exactly the JSON that would
 * live there, so lifting it into a full BundlePayload later is additive,
 * not a rewrite. The bundle itself is not DSSE-signed by the production key
 * (see this file's own header note under buildCommerceLifecycleBundle) —
 * its integrity comes from content-addressing plus the digest link carried
 * by the (signed) public receipt, not from a second signature.
 */
import { contentId } from './receipts.js'
import type { PreflightAction, PreflightPolicy } from './preflight.js'
import type { DecodedPaymentAuthorization } from './paymentAuthorization.js'
import type { FinalityEvaluation } from './finality.js'

export const COMMERCE_LIFECYCLE_PROFILE = 'onchaindiligence.commerce-lifecycle.v1'
export const NORMALIZATION_VERSION = 'onchaindiligence.commerce-normalization.v1'
export const EVALUATOR_ID = 'onchaindiligence.preflight-evaluator'
export const EVALUATOR_VERSION = 'v1'

// ---------------------------------------------------------------------
// Claim model (three levels, never conflated). See the task's own
// definitions -- reproduced here as the single place that names them.
// ---------------------------------------------------------------------
export type BindingStrength = 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED'

export interface BindingInputs {
  /** True only when the observed transfer's recipient/asset/amount/(sender) exactly match what the preflight proposed -- see commerceReceipt.ts's own matching, reused via its output. */
  transferFieldsMatch: boolean
  /** True only when this observation was reached through a durable execution_binding row that itself references this exact operation + frozen preflight receipt (Section 6) -- never true merely because the caller supplied a transaction hash. */
  executorCorrelated: boolean
  /** The `expected_payer` frozen at preflight/binding time, if the caller committed to one. Null means no commitment was made -- and per the claim model, "never treat field similarity alone as proof of causality", the absence of a commitment can NEVER be papered over by field-matching alone. */
  expectedPayer: string | null
  /** The authorizer decoded independently from the on-chain transaction's own calldata (paymentAuthorization.ts). Null when calldata decoding failed or wasn't attempted. */
  observedAuthorizer: string | null
}

function addressesEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

/**
 * Deterministic, order-independent derivation. An old/unrelated matching
 * transfer (fields match, nothing else) can NEVER reach past
 * TRANSFER_MATCH_ONLY. PAYMENT_IDENTITY_LINKED requires BOTH a durable
 * executor correlation AND an independently-decoded on-chain authorizer
 * that matches a commitment made BEFORE observation -- never the reverse
 * (matching after the fact proves nothing about intent).
 */
export function deriveBindingStrength(inputs: BindingInputs): BindingStrength {
  if (!inputs.transferFieldsMatch) return 'TRANSFER_MATCH_ONLY' // reported for transparency even on a mismatch; callers must still treat this as unattributed
  if (!inputs.executorCorrelated) return 'TRANSFER_MATCH_ONLY'
  if (inputs.expectedPayer !== null && inputs.observedAuthorizer !== null && addressesEqual(inputs.expectedPayer, inputs.observedAuthorizer)) {
    return 'PAYMENT_IDENTITY_LINKED'
  }
  return 'EXECUTOR_CORRELATED'
}

// ---------------------------------------------------------------------
// Section 5 — immutable preflight commitments.
// ---------------------------------------------------------------------
export interface PreflightCommitment {
  normalization_version: typeof NORMALIZATION_VERSION
  action_digest: string
  policy_digest: string
  evaluator_id: typeof EVALUATOR_ID
  evaluator_version: typeof EVALUATOR_VERSION
  evaluation_options: { screen_recipient_sanctions: boolean }
  evidence_refs: string[]
  expected_payer: string | null
  expected_recipient: string | null
  network: string
  asset: string
  amount_atomic: string | null
  resource_commitment: string | null
  issued_at: string
  execution_valid_until: string
}

/**
 * Freezes the exact D2.4 proposal before execution. `action`/`policy` MUST
 * be the already-parsed, already-validated PreflightAction/PreflightPolicy
 * (never raw request bytes -- credential headers and secrets are excluded
 * from evidence by construction, since they never appear in these typed
 * objects at all). `issuedAt` and `executionValidUntil` must be frozen by
 * the caller ONCE (never `new Date()` inside this pure function), so a
 * retried call over the identical action/policy always produces the
 * identical digest -- see lifecycleRoute.ts's resumable claim flow.
 */
export function buildPreflightCommitment(params: {
  action: PreflightAction
  policy: PreflightPolicy
  screenRecipientSanctions: boolean
  evidenceRefs: string[]
  amountAtomic: string | null
  issuedAt: string
  executionValidUntil: string
}): PreflightCommitment {
  return {
    normalization_version: NORMALIZATION_VERSION,
    action_digest: contentId(params.action),
    policy_digest: contentId(params.policy),
    evaluator_id: EVALUATOR_ID,
    evaluator_version: EVALUATOR_VERSION,
    evaluation_options: { screen_recipient_sanctions: params.screenRecipientSanctions },
    evidence_refs: params.evidenceRefs,
    expected_payer: params.policy.expected_payer ?? null,
    expected_recipient: params.policy.expected_recipient,
    network: params.action.network,
    asset: params.action.asset,
    amount_atomic: params.amountAtomic,
    resource_commitment: params.action.resource,
    issued_at: params.issuedAt,
    execution_valid_until: params.executionValidUntil,
  }
}

// ---------------------------------------------------------------------
// Full bundle (Section 1's minimum evidence list).
// ---------------------------------------------------------------------
export interface ExecutionBindingCommitment {
  execution_request_id: string
  executor_identity: string
  executor_version: string
  recovery_capability_class: 'provider-idempotent' | 'stable-payment-identity' | 'none'
  provider_reference: string | null
}

export interface ExactObservationIdentity {
  network: string
  block_number: string
  block_hash: string
  transaction_hash: string
  log_index: number
  observed_payer: string | null
  observed_recipient: string | null
  observed_amount_atomic: string | null
  token_contract: string
}

export interface PaymentIdentityCommitment {
  authorizer: string | null
  nonce: string | null
}

export interface PriorObservationLink {
  prior_observation_bundle_digest: string
  prior_receipt_id: string | null
  relationship: 'reconciliation' | 'reorg-re-observation'
}

export interface CommerceLifecycleBundleV1 {
  profile: typeof COMMERCE_LIFECYCLE_PROFILE
  operation_id: string
  preflight_commitment: PreflightCommitment
  preflight_receipt_id: string
  preflight_receipt_digest: string
  execution_binding: ExecutionBindingCommitment | null
  observation: ExactObservationIdentity | null
  payment_identity: PaymentIdentityCommitment | null
  finality: FinalityEvaluation | null
  prior_observation: PriorObservationLink | null
  binding_strength: BindingStrength
  created_at: string
}

/**
 * Builds the bundle content and its digest. `preflight_receipt_id` +
 * `preflight_receipt_digest` are what this bundle references (never the
 * Commerce receipt that will in turn reference THIS bundle -- see this
 * file's header on avoiding circular digest dependencies: the Commerce
 * receipt is built strictly AFTER this bundle's digest is known).
 *
 * Not DSSE-signed: this is private evidence whose integrity is content-
 * addressing plus the (signed) public receipt's link to `bundle_digest`,
 * not a second production signature -- see this file's header.
 */
export function buildCommerceLifecycleBundle(
  fields: Omit<CommerceLifecycleBundleV1, 'profile'>
): { bundle: CommerceLifecycleBundleV1; digest: string } {
  const bundle: CommerceLifecycleBundleV1 = { profile: COMMERCE_LIFECYCLE_PROFILE, ...fields }
  return { bundle, digest: contentId(bundle) }
}
