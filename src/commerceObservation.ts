/**
 * commerceObservation.ts — records ONE exact chain-event observation for an
 * operation (D2.4, Sections 8-10), deriving finality and binding strength,
 * and building the linked commerce-lifecycle.v1 bundle.
 *
 * This is ADDITIVE to, not a replacement of, the legacy finalize flow
 * (finalizeRoute.ts / commerceReceipt.ts): it is called ALONGSIDE the
 * existing finalizePayment() for operation-bound lifecycles, never in place
 * of it. The legacy Commerce receipt's own execution/settlement fields keep
 * coming from the unchanged, already-deployed confirmation-count logic in
 * settlement.ts; this module only adds the exact-identity, finality-policy,
 * and binding-strength evidence the D2.4 profile requires, as private
 * evidence linked from the receipt via `links.agent_evidence_bundle_digest`.
 *
 * Deterministic log selection (Section 8): when a transaction carries
 * multiple Transfer logs of the expected asset and no single one is an
 * EXACT preflight match, this module — unlike commerceReceipt.ts's
 * existing "pick the largest transfer" heuristic used only for the
 * legacy receipt's human-readable summary fields — selects the transfer
 * with the LOWEST log_index among recipient-matching candidates, and falls
 * through to the lowest log_index overall if none match the recipient. This
 * is order-based and reproducible, never value-based, but it is used only
 * to pick WHICH exact event this observation row is about — it does not by
 * itself grant any binding strength above TRANSFER_MATCH_ONLY.
 */
import { getAddress } from 'viem'
import type { ObservedTransfer, SettlementObservation } from './settlement.js'
import { evaluateBaseFinality, BASE_FINALITY_POLICY, type MinimalFinalityClient, type FinalityEvaluation } from './finality.js'
import { deriveBindingStrength, buildCommerceLifecycleBundle, type BindingStrength, type CommerceLifecycleBundleV1 } from './commerceLifecycle.js'
import { recordCommerceObservation, type CommerceObservationRecord, type ExecutionBindingRecord } from './db.js'

function addressesEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

/**
 * Deterministic selection among candidate transfers of the expected asset.
 * Never "largest amount" — see file header. Returns null only when there
 * are no transfers of the expected asset at all.
 */
export function selectExactTransfer(transfers: ObservedTransfer[], expectedRecipient: string | null): ObservedTransfer | null {
  if (transfers.length === 0) return null
  const sorted = [...transfers].sort((a, b) => a.logIndex - b.logIndex)
  if (expectedRecipient) {
    const recipientMatches = sorted.filter((t) => addressesEqual(t.to, expectedRecipient))
    if (recipientMatches.length > 0) return recipientMatches[0]!
  }
  return sorted[0]!
}

export interface RecordObservationParams {
  operationId: string
  network: string
  observation: SettlementObservation
  selectedTransfer: ObservedTransfer | null
  expectedPayer: string | null
  transferFieldsMatch: boolean
  executionBinding: ExecutionBindingRecord | null
  preflightReceiptId: string
  preflightReceiptDigest: string
  preflightCommitment: CommerceLifecycleBundleV1['preflight_commitment']
  tokenContract: string
  finalityClient: MinimalFinalityClient | null
  priorObservation: CommerceLifecycleBundleV1['prior_observation']
}

export interface CommerceObservationDependencies {
  recordCommerceObservation?: typeof recordCommerceObservation
}

export interface RecordObservationResult {
  created: boolean
  observation: CommerceObservationRecord | null
  bundle: CommerceLifecycleBundleV1
  bundleDigest: string
  bindingStrength: BindingStrength
}

/**
 * Records one observation for a successfully-confirmed transaction. Callers
 * MUST NOT call this for a still-pending/RPC-unavailable/not-found
 * observation (finalizeRoute.ts's existing FinalizationPendingError gate
 * already prevents that for the legacy path; the operation-bound route
 * applies the identical gate before ever reaching here).
 */
export async function recordObservation(
  params: RecordObservationParams,
  deps: CommerceObservationDependencies = {}
): Promise<RecordObservationResult> {
  const { observation, selectedTransfer } = params

  let finality: FinalityEvaluation
  if (observation.state === 'reverted') {
    finality = {
      policy: BASE_FINALITY_POLICY,
      state: 'reverted',
      chainHeadUsed: null,
      selectedBlock: { number: observation.blockNumber?.toString() ?? '0', hash: selectedTransfer?.blockHash ?? '' },
    }
  } else if (params.finalityClient && observation.blockNumber !== null && selectedTransfer) {
    finality = await evaluateBaseFinality(params.finalityClient, observation.blockNumber, selectedTransfer.blockHash as `0x${string}`)
  } else {
    finality = {
      policy: BASE_FINALITY_POLICY,
      state: 'unverifiable',
      chainHeadUsed: null,
      selectedBlock: { number: observation.blockNumber?.toString() ?? '0', hash: selectedTransfer?.blockHash ?? '' },
    }
  }

  const executorCorrelated =
    params.executionBinding !== null &&
    params.executionBinding.operationId === params.operationId &&
    params.executionBinding.frozenPreflightReceiptDigest === params.preflightReceiptDigest

  const observedAuthorizer = observation.paymentAuthorization?.authorizer ?? null
  const bindingStrength = deriveBindingStrength({
    transferFieldsMatch: params.transferFieldsMatch,
    executorCorrelated,
    expectedPayer: params.expectedPayer,
    observedAuthorizer,
  })

  const observationIdentity = selectedTransfer
    ? {
        network: params.network,
        block_number: observation.blockNumber?.toString() ?? '0',
        block_hash: selectedTransfer.blockHash,
        transaction_hash: selectedTransfer.transactionHash,
        log_index: selectedTransfer.logIndex,
        observed_payer: selectedTransfer.from,
        observed_recipient: selectedTransfer.to,
        observed_amount_atomic: selectedTransfer.amountAtomic.toString(),
        token_contract: getAddress(params.tokenContract),
      }
    : null

  const { bundle, digest: bundleDigest } = buildCommerceLifecycleBundle({
    operation_id: params.operationId,
    preflight_commitment: params.preflightCommitment,
    preflight_receipt_id: params.preflightReceiptId,
    preflight_receipt_digest: params.preflightReceiptDigest,
    execution_binding: params.executionBinding
      ? {
          execution_request_id: params.executionBinding.executionRequestId,
          executor_identity: params.executionBinding.executorIdentity,
          executor_version: params.executionBinding.executorVersion,
          recovery_capability_class: params.executionBinding.recoveryCapabilityClass,
          provider_reference: params.executionBinding.providerReference,
        }
      : null,
    observation: observationIdentity,
    payment_identity: observation.paymentAuthorization
      ? { authorizer: observation.paymentAuthorization.authorizer, nonce: observation.paymentAuthorization.nonce }
      : null,
    finality,
    prior_observation: params.priorObservation,
    binding_strength: bindingStrength,
    created_at: new Date().toISOString(),
  })

  if (!selectedTransfer) {
    // No transfer of the expected asset to attach an exact identity to —
    // there is nothing to append-only-record as an observation row. The
    // bundle above still exists (documenting "no qualifying transfer was
    // found") and its digest is returned so callers can still link it.
    return { created: false, observation: null, bundle, bundleDigest, bindingStrength }
  }

  // Content-derived, not random: the SAME exact event always maps to the
  // SAME observation_id, so recomputing it is itself idempotent even before
  // the DB's own unique constraint is consulted.
  const observationId = `sha256:${Buffer.from(`${params.network}:${selectedTransfer.blockHash}:${selectedTransfer.transactionHash}:${selectedTransfer.logIndex}`).toString('base64url')}`

  const { created, observation: stored } = await (deps.recordCommerceObservation ?? recordCommerceObservation)({
    observationId,
    operationId: params.operationId,
    network: params.network,
    blockNumber: observation.blockNumber?.toString() ?? '0',
    blockHash: selectedTransfer.blockHash,
    transactionHash: selectedTransfer.transactionHash,
    logIndex: selectedTransfer.logIndex,
    observedPayer: selectedTransfer.from,
    observedRecipient: selectedTransfer.to,
    observedAmountAtomic: selectedTransfer.amountAtomic.toString(),
    tokenContract: getAddress(params.tokenContract),
    paymentAuthorizer: observedAuthorizer,
    paymentAuthorizationNonce: observation.paymentAuthorization?.nonce ?? null,
    finalityPolicy: finality.policy,
    finalityState: finality.state,
    chainHeadUsed: finality.chainHeadUsed,
    bindingStrength,
    bundleDigest,
  })

  return { created, observation: stored, bundle, bundleDigest, bindingStrength }
}
