/**
 * investigation.ts — D2.7C investigation package + evidence export.
 *
 * Builds ENTIRELY on top of D2.7A's getOperationDetailForOwner() -- no new
 * DB queries, no new lifecycle logic, no new receipt format. This module
 * only reshapes/regroups the same already-assembled data into the
 * "operation/preflight/execution/settlement/receipts/evidence/recovery"
 * envelope the product question calls for, and adds a manifest + a
 * deterministic digest (reusing receipts.ts's existing contentId()
 * canonicalizer -- the same one commerce_observations' own observation_id
 * and receipt digests already use, not a new canonicalization scheme).
 *
 * Nothing here is a NEW cryptographic claim: the signed Public Action
 * Receipt envelopes (preflight_receipt/commerce_receipt below) remain the
 * actual evidence. The investigation package is an assembled, integrity-
 * checked CONTAINER around them, not a new source of truth.
 */
import { getOperationDetailForOwner, type OperationDetail } from './operationHistory.js'
import { contentId } from './receipts.js'
import { verifyReceipt } from './receiptTools.js'
import { getStepState } from './lifecycleSteps.js'
import { listMerchantEvidenceForOperation } from './db.js'
import { deriveFindings, summarizeFindings, type Finding } from './findings.js'

export interface Investigation {
  operation: {
    operation_id: string
    created_at: string
    preflight_state: OperationDetail['preflight_state']
    execution_state: OperationDetail['execution_state']
    observation_state: OperationDetail['observation_state']
    receipt_state: OperationDetail['receipt_state']
  }
  preflight: {
    receipt_id: string | null
    decision: string | null
    action: unknown | null
    verification: { state: string; code: string; message: string } | null
    /**
     * D2.8A correction: the ACTUAL frozen D2.4 `policy.expected_payer`
     * commitment (from the 'preflight' lifecycle step's frozen input) --
     * NOT the same thing as `action.sender` (checked by the receipt's own
     * sender-matches-preflight) or execution.expected_payer below (the
     * execution binding's own, caller-supplied field, never cross-
     * validated against this frozen policy commitment). Null means no
     * commitment was ever made -- per the D2.4 claim model, that can never
     * be treated as satisfied by field similarity alone. See findings.ts's
     * EXPECTED_PAYER_MISMATCH vs SENDER_MISMATCH for why these two are
     * deliberately kept separate.
     */
    expected_payer: string | null
  }
  execution: {
    execution_request_id: string | null
    client_submission_key: string | null
    executor_identity: string | null
    executor_version: string | null
    recovery_capability_class: string | null
    provider_reference: string | null
    submission_state: string | null
    expected_payer: string | null
    transaction_hash: string | null
  }
  settlement: {
    network: string | null
    transaction_hash: string | null
    block_hash: string | null
    block_number: string | null
    log_index: number | null
    payer: string | null
    recipient: string | null
    asset: string | null
    amount_atomic: string | null
    finality_state: string | null
    settlement_state: string | null
  }
  evidence: {
    bundle_digest: string | null
    binding_strength: OperationDetail['observations'][number]['binding_strength'] | null
    event_identity: { network: string; block_hash: string | null; transaction_hash: string; log_index: number } | null
    observation_state: OperationDetail['observation_state']
  }
  receipts: {
    preflight: OperationDetail['preflight_receipt']
    commerce: OperationDetail['commerce_receipt']
    verification: OperationDetail['commerce_receipt_verification']
  }
  recovery: {
    needs_attention: boolean
    may_already_have_paid: boolean
    summary: string
    safe_next_action: string
  }
  /**
   * D2.9A: "the payment happened, what did the merchant actually return?"
   * -- every record here is `source: CALLER_REPORTED` (see
   * merchantEvidence.ts's header for why this can never be upgraded to an
   * independent OCD claim). Oldest-first, same convention as
   * execution_bindings/observations above -- the last element is "current".
   */
  merchant_response: {
    evidence: Array<{
      evidence_id: string
      resource_url: string
      http_status: number
      content_type: string | null
      body_digest: string
      response_bytes: number | null
      source: 'CALLER_REPORTED'
      execution_request_id: string | null
      provider_reference: string | null
      transaction_hash: string | null
      /** null when no transaction_hash was submitted with this evidence record -- otherwise whether it matches a transaction hash OCD has independently observed for this operation. */
      transaction_hash_matches_known_observation: boolean | null
      recorded_at: string
    }>
  }
  /** D2.8A: deterministic findings derived from the fields above -- see findings.ts. Computed, never persisted; the export digest below naturally covers it since it's part of this same object. */
  findings: Finding[]
}

export type InvestigationResult = { found: true; investigation: Investigation } | { found: false }

/** Same ownership discipline as D2.7A: unowned/wrong-account is indistinguishable from unknown. */
export interface GetInvestigationDependencies {
  getOperationDetailForOwner?: typeof getOperationDetailForOwner
  verifyReceipt?: typeof verifyReceipt
  getStepState?: typeof getStepState
  listMerchantEvidenceForOperation?: typeof listMerchantEvidenceForOperation
}

export async function getInvestigationForOwner(operationId: string, accountId: string, deps: GetInvestigationDependencies = {}): Promise<InvestigationResult> {
  const doGetDetail = deps.getOperationDetailForOwner ?? getOperationDetailForOwner
  const doVerifyReceipt = deps.verifyReceipt ?? verifyReceipt
  const doGetStepState = deps.getStepState ?? getStepState
  const doListMerchantEvidence = deps.listMerchantEvidenceForOperation ?? listMerchantEvidenceForOperation
  const result = await doGetDetail(operationId, accountId)
  if (!result.found) return { found: false }
  const detail = result.detail

  // D2.8A correction: the frozen D2.4 policy commitment, read from the
  // SAME 'preflight' lifecycle_steps row lifecycleFinalizeRoute.ts itself
  // reads at finalize time (reconstructPreflightCommitment) -- never the
  // execution binding's own expected_payer field, which is caller-supplied
  // at binding-creation time and not cross-validated against this.
  const preflightStep = await doGetStepState(operationId, 'preflight')
  const frozenExpectedPayer: string | null = (preflightStep?.frozenInput as any)?.input?.policy?.expected_payer ?? null

  // D2.9A: known on-chain transaction hashes for this operation, used only
  // to compute whether a CALLER_REPORTED transaction_hash matches
  // something OCD has independently observed -- never to upgrade the
  // evidence's own source away from CALLER_REPORTED.
  const merchantEvidenceRows = await doListMerchantEvidence(operationId)
  const knownTransactionHashes = new Set(detail.observations.map((o) => o.transaction_hash.toLowerCase()))

  // "Current" binding/observation: the most recent of each -- D2.4 allows
  // more than one only if a caller genuinely attempted more than one
  // distinct client_submission_key/on-chain event, and both arrays are
  // already ordered oldest-first (see operationHistory.ts).
  const binding = detail.execution_bindings.length > 0 ? detail.execution_bindings[detail.execution_bindings.length - 1] : null
  const observation = detail.observations.length > 0 ? detail.observations[detail.observations.length - 1] : null
  const preflightAction = (detail.preflight_receipt as any)?.receipt?.action ?? null
  const preflightDecision = (detail.preflight_receipt as any)?.receipt?.decision?.status ?? null
  const commerceSettlementStatus = (detail.commerce_receipt as any)?.receipt?.settlement?.status ?? null
  // Reuses the SAME verifyReceipt() contract getOperationDetailForOwner()
  // already applies to the commerce receipt -- one extra cheap, local
  // signature check, no new DB round trip.
  const preflightVerification = detail.preflight_receipt ? await doVerifyReceipt({ envelope: detail.preflight_receipt }) : null

  const investigationWithoutFindings: Omit<Investigation, 'findings'> = {
    operation: {
      operation_id: detail.operation_id,
      created_at: detail.created_at,
      preflight_state: detail.preflight_state,
      execution_state: detail.execution_state,
      observation_state: detail.observation_state,
      receipt_state: detail.receipt_state,
    },
    preflight: {
      receipt_id: detail.preflight_receipt_id,
      decision: preflightDecision,
      action: preflightAction,
      verification: preflightVerification,
      expected_payer: frozenExpectedPayer,
    },
    execution: {
      execution_request_id: binding?.execution_request_id ?? null,
      client_submission_key: binding?.client_submission_key ?? null,
      executor_identity: binding?.executor_identity ?? null,
      executor_version: binding?.executor_version ?? null,
      recovery_capability_class: binding?.recovery_capability_class ?? null,
      provider_reference: binding?.provider_reference ?? null,
      submission_state: binding?.submission_state ?? null,
      expected_payer: binding?.expected_payer ?? null,
      transaction_hash: observation?.transaction_hash ?? null,
    },
    settlement: {
      network: observation?.network ?? null,
      transaction_hash: observation?.transaction_hash ?? null,
      block_hash: observation?.block_hash ?? null,
      block_number: observation?.block_number ?? null,
      log_index: observation?.log_index ?? null,
      payer: observation?.observed_payer ?? null,
      recipient: observation?.observed_recipient ?? null,
      asset: observation?.token_contract ?? null,
      amount_atomic: observation?.observed_amount_atomic ?? null,
      finality_state: observation?.finality_state ?? null,
      settlement_state: commerceSettlementStatus,
    },
    evidence: {
      bundle_digest: observation?.bundle_digest ?? null,
      binding_strength: observation?.binding_strength ?? null,
      event_identity: observation ? { network: observation.network, block_hash: observation.block_hash ?? null, transaction_hash: observation.transaction_hash, log_index: observation.log_index } : null,
      observation_state: detail.observation_state,
    },
    receipts: {
      preflight: detail.preflight_receipt,
      commerce: detail.commerce_receipt,
      verification: detail.commerce_receipt_verification,
    },
    recovery: {
      needs_attention: detail.recovery.needsAttention,
      may_already_have_paid: detail.recovery.mayAlreadyHavePaid,
      summary: detail.recovery.summary,
      safe_next_action: detail.recovery.safeNextAction,
    },
    merchant_response: {
      evidence: merchantEvidenceRows.map((e) => ({
        evidence_id: e.evidenceId,
        resource_url: e.resourceUrl,
        http_status: e.httpStatus,
        content_type: e.contentType,
        body_digest: e.responseBodyDigest,
        response_bytes: e.responseBytes,
        source: e.source,
        execution_request_id: e.executionRequestId,
        provider_reference: e.providerReference,
        transaction_hash: e.transactionHash,
        transaction_hash_matches_known_observation: e.transactionHash ? knownTransactionHashes.has(e.transactionHash.toLowerCase()) : null,
        recorded_at: e.recordedAt,
      })),
    },
  }

  const investigation: Investigation = { ...investigationWithoutFindings, findings: deriveFindings(investigationWithoutFindings) }

  return { found: true, investigation }
}

export interface InvestigationExport {
  schema: 'onchaindiligence.investigation.v1'
  generated_at: string
  operation_id: string
  account_id: string
  artifacts: Array<{ id: string; type: string; digest?: string | null }>
  digest: string
  investigation: Investigation
}

/** Wraps an already-built Investigation in a manifest + a deterministic digest of the investigation content, reusing receipts.ts's existing contentId() canonicalizer -- no new signing/crypto. */
export function buildInvestigationExport(params: { accountId: string; investigation: Investigation }): InvestigationExport {
  const { investigation } = params
  const artifacts: InvestigationExport['artifacts'] = []
  if (investigation.preflight.receipt_id) artifacts.push({ id: investigation.preflight.receipt_id, type: 'preflight_receipt' })
  if (investigation.receipts.commerce) {
    const receiptId = (investigation.receipts.commerce as any)?.receipt?.receipt_id ?? null
    if (receiptId) artifacts.push({ id: receiptId, type: 'commerce_receipt' })
  }
  if (investigation.execution.execution_request_id) artifacts.push({ id: investigation.execution.execution_request_id, type: 'execution_binding' })
  if (investigation.evidence.bundle_digest) artifacts.push({ id: investigation.evidence.bundle_digest, type: 'lifecycle_evidence_bundle', digest: investigation.evidence.bundle_digest })

  return {
    schema: 'onchaindiligence.investigation.v1',
    generated_at: new Date().toISOString(),
    operation_id: investigation.operation.operation_id,
    account_id: params.accountId,
    artifacts,
    // A JSON round-trip first: contentId()'s canonicalizer (receipts.ts)
    // throws on a literal `undefined` anywhere in the tree, which JSON.stringify
    // would otherwise have silently dropped (the same normalization the HTTP
    // response itself already applies) -- this keeps the digest computable
    // over exactly the content that actually gets served, rather than making
    // the whole export request fail on an edge case that isn't a real problem.
    digest: contentId(JSON.parse(JSON.stringify(investigation))),
    investigation,
  }
}

function humanizeState(value: string | null): string {
  return value ? value.replace(/_/g, ' ') : 'unknown'
}

/**
 * Deterministic, template-based summary -- no LLM call, Section 7. Same
 * field mapping the app's client-side "Copy investigation summary" button
 * mirrors in JS (src/lib/investigation.js) for the case a caller only has
 * the JSON, not this function.
 */
export function summarizeInvestigation(investigation: Investigation): string {
  const lines: string[] = [`Operation ${investigation.operation.operation_id}`]
  lines.push(`Decision: ${investigation.preflight.decision ?? 'not yet available'}`)
  lines.push(`Execution: ${humanizeState(investigation.execution.submission_state ?? investigation.operation.execution_state)}`)
  lines.push(`Settlement: ${investigation.settlement.settlement_state ?? investigation.settlement.finality_state ?? 'not yet available'}`)
  lines.push(`Receipt: ${investigation.receipts.verification?.state ?? 'not yet issued'}`)
  lines.push(`Binding: ${investigation.evidence.binding_strength ?? 'not yet available'}`)
  if (investigation.recovery.needs_attention) {
    lines.push(`Recovery: ${investigation.recovery.summary} Safe next action: ${investigation.recovery.safe_next_action}`)
  } else {
    lines.push('Recovery: none required')
  }
  lines.push(summarizeFindings(investigation.findings))
  return lines.join('\n')
}
