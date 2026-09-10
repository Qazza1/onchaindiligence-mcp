/**
 * findings.ts — D2.8A deterministic findings/contradiction engine.
 *
 * Answers "what is actually wrong, suspicious, uncertain, or contradictory
 * about this agent action?" by inspecting the ALREADY-ASSEMBLED D2.7C
 * Investigation object -- no new evidence model, no new DB query, no LLM
 * call. Every rule below reads a fact this product already independently
 * established:
 *   - receipt verification state (receiptTools.ts's verifyReceipt(), D2.3)
 *   - the Commerce receipt's own *-matches-preflight checks
 *     (commerceReceipt.ts, D2.2B2) -- reused rather than re-deriving amount/
 *     recipient/payer comparisons ourselves, which would risk comparing a
 *     DECIMAL preflight amount against an ATOMIC observed amount incorrectly
 *   - D2.4's lifecycle state machine (execution_state/observation_state)
 *   - D2.4's binding_strength claim model
 *   - D2.7A's deriveRecoveryStatus() (reused, never re-derived)
 *
 * Claim discipline (Section 3): every finding states a fact, an
 * uncertainty, or a contradiction between two already-established facts --
 * never an inference about intent ("fraud", "stolen", "malicious"). See
 * each rule's summary text.
 */
import type { Investigation } from './investigation.js'
import { detectContradictions, mapTaxonomyFindings, type D33DetectionContext } from './contradictionDetection.js'
import type { FindingClass } from './contradictionTaxonomy.js'

export type FindingSeverity = 'info' | 'warning' | 'critical'
export type FindingCategory = 'policy' | 'execution' | 'settlement' | 'evidence' | 'receipt' | 'recovery'

export interface Finding {
  /** D3.3 taxonomy class when this is a taxonomy finding; null for legacy D2.8 findings. */
  finding_class: FindingClass | null
  code: string
  severity: FindingSeverity
  category: FindingCategory
  title: string
  summary: string
  /** Compact, non-secret identifiers supporting this finding -- receipt ids, execution_request_id, provider_reference, transaction hash, event identity, evidence digest. Never a recovery credential, API key, or capability token (none of those ever reach this module -- see investigation.ts's own exclusions). */
  evidence_refs: string[]
  recommended_action: string | null
}

function refs(...values: Array<string | null | undefined>): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function receiptId(envelope: Investigation['receipts']['commerce']): string | null {
  return (envelope as any)?.receipt?.receipt_id ?? null
}

function receiptCheck(envelope: Investigation['receipts']['commerce'], checkId: string): { result: string; summary: string } | null {
  const checks = (envelope as any)?.receipt?.checks as Array<{ id: string; result: string; summary: string }> | undefined
  return checks?.find((c) => c.id === checkId) ?? null
}

/** Same convention as commerceObservation.ts/commerceReceipt.ts's own private addressesEqual() helpers -- not exported anywhere in this codebase, so each file keeps its own small copy rather than inventing a shared util for a 2-line comparison. */
function addressesEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

/**
 * Pure and deterministic: same Investigation in, same Finding[] out, every
 * time. Bounded by construction -- one rule contributes at most one
 * finding, and there are a fixed, small number of rules.
 *
 * Takes the investigation WITHOUT its own `findings` field -- this is what
 * computes that field, so it necessarily runs before `findings` exists on
 * the object being assembled (see investigation.ts's getInvestigationForOwner()).
 */
function deriveLegacyFindings(investigation: Omit<Investigation, 'findings'>): Array<Omit<Finding, 'finding_class'>> {
  const findings: Array<Omit<Finding, 'finding_class'>> = []
  const { operation, preflight, execution, settlement, evidence, receipts, recovery, merchant_response } = investigation

  // --- RECEIPT_INVALID / RECEIPT_UNVERIFIABLE (receipt category) ----------
  for (const [label, verification, id] of [
    ['preflight', preflight.verification, preflight.receipt_id],
    ['commerce', receipts.verification, receiptId(receipts.commerce)],
  ] as const) {
    if (!verification) continue
    if (verification.state === 'INVALID') {
      findings.push({
        code: 'RECEIPT_INVALID',
        severity: 'critical',
        category: 'receipt',
        title: `${label === 'preflight' ? 'Preflight' : 'Commerce'} receipt independently verifies INVALID`,
        summary: `The ${label} receipt failed independent verification (${verification.code}: ${verification.message}). This is a structural/cryptographic problem with the receipt itself, not a statement about the underlying payment.`,
        evidence_refs: refs(id),
        recommended_action: 'Do not treat this receipt as trustworthy evidence. Investigate how it was produced/stored before relying on it.',
      })
    } else if (verification.state === 'UNVERIFIABLE') {
      findings.push({
        code: 'RECEIPT_UNVERIFIABLE',
        severity: 'warning',
        category: 'receipt',
        title: `${label === 'preflight' ? 'Preflight' : 'Commerce'} receipt verification is UNVERIFIABLE`,
        summary: `The ${label} receipt exists but could not be independently verified as VALID or INVALID (${verification.code}: ${verification.message}) -- for example, its signing key metadata may be unavailable. This is distinct from a proven-invalid receipt.`,
        evidence_refs: refs(id),
        recommended_action: 'Retry verification later, or verify offline against a trusted key registry snapshot.',
      })
    }
  }

  // --- MANUAL_RECOVERY_REQUIRED (execution category) ----------------------
  if (operation.execution_state === 'manual_recovery_required') {
    findings.push({
      code: 'MANUAL_RECOVERY_REQUIRED',
      severity: 'critical',
      category: 'execution',
      title: 'Execution requires manual recovery',
      summary: 'The executor reported that this operation requires manual recovery -- OCD will not automatically resolve it.',
      evidence_refs: refs(execution.execution_request_id, execution.provider_reference),
      recommended_action: recovery.safe_next_action,
    })
  }

  // --- EXECUTION_OUTCOME_UNCERTAIN (execution category) -------------------
  if (operation.execution_state === 'submission_ambiguous' || operation.execution_state === 'outcome_unknown') {
    findings.push({
      code: 'EXECUTION_OUTCOME_UNCERTAIN',
      severity: recovery.may_already_have_paid ? 'critical' : 'warning',
      category: 'execution',
      title: 'Execution outcome is not yet definitively known',
      summary: recovery.may_already_have_paid
        ? 'Execution may already have been submitted to the payment provider, but OCD does not yet have a definitive outcome. This is an open uncertainty, not a proven failure.'
        : 'The execution outcome is not yet definitively known, though a provider submission is not confirmed to have happened yet.',
      evidence_refs: refs(execution.execution_request_id, execution.provider_reference),
      recommended_action: recovery.safe_next_action,
    })
  }

  // --- OBSERVATION_CONTRADICTED (settlement category) ---------------------
  if (operation.observation_state === 'contradicted') {
    findings.push({
      code: 'OBSERVATION_CONTRADICTED',
      severity: 'critical',
      category: 'settlement',
      title: 'A later on-chain observation contradicted an earlier one',
      summary: 'OCD recorded more than one on-chain observation for this operation, and a later one contradicts an earlier one. Both observations are preserved (append-only) -- neither was overwritten.',
      evidence_refs: refs(settlement.transaction_hash, evidence.bundle_digest),
      recommended_action: recovery.safe_next_action,
    })
  }

  // --- SENDER_MISMATCH / RECIPIENT_MISMATCH / AMOUNT_MISMATCH -------------
  // Reused directly from the Commerce receipt's own *-matches-preflight
  // checks (commerceReceipt.ts) rather than re-comparing raw fields here --
  // those checks already handle unit conversion (preflight amounts are
  // decimal, observed amounts are atomic) correctly; re-deriving that
  // comparison in this module would risk a unit-mismatch bug and would
  // duplicate existing lifecycle logic, which Section 1 explicitly says not
  // to do.
  //
  // D2.8A correction: `sender-matches-preflight` compares the preflight
  // ACTION's `sender` (a plain field on the frozen action, only checked
  // when the caller actually set it) against the observed transfer's
  // sender -- this is NOT the same commitment as D2.4's
  // `policy.expected_payer` (a separate, optional binding-strength
  // commitment). Conflating the two would misrepresent which commitment
  // was actually violated. This rule is named SENDER_MISMATCH accordingly;
  // EXPECTED_PAYER_MISMATCH (below) is a completely separate comparison
  // against the true frozen policy commitment.
  const mismatchChecks: Array<{ code: string; checkId: string; title: string; fieldLabel: string }> = [
    { code: 'SENDER_MISMATCH', checkId: 'sender-matches-preflight', title: 'Observed sender does not match the sender specified in the preflight action', fieldLabel: 'sender' },
    { code: 'RECIPIENT_MISMATCH', checkId: 'recipient-matches-preflight', title: 'Observed recipient does not match the recipient proposed in preflight', fieldLabel: 'recipient' },
    { code: 'AMOUNT_MISMATCH', checkId: 'amount-matches-preflight', title: 'Observed amount does not match the amount proposed in preflight', fieldLabel: 'amount' },
  ]
  for (const { code, checkId, title, fieldLabel } of mismatchChecks) {
    // sender-matches-preflight is NOT_CHECKED (not FAIL) when action.sender
    // was never specified -- see commerceReceipt.ts's matchCheck() -- so
    // this naturally only fires when action.sender was actually set.
    const check = receiptCheck(receipts.commerce, checkId)
    if (check && check.result === 'FAIL') {
      findings.push({
        code,
        severity: 'critical',
        category: 'settlement',
        title,
        summary: `The observed ${fieldLabel} differs from the ${fieldLabel} frozen in the preflight commitment. ${check.summary}`,
        evidence_refs: refs(receiptId(receipts.commerce), preflight.receipt_id, settlement.transaction_hash),
        recommended_action: 'Review the transaction before treating this operation as reconciled. Do not assume intent -- this records a factual mismatch between the preflighted and observed transfer.',
      })
    }
  }

  // --- EXPECTED_PAYER_MISMATCH (settlement category) ----------------------
  // Compares the TRUE frozen D2.4 `policy.expected_payer` commitment
  // (investigation.ts surfaces it from the 'preflight' lifecycle step's
  // frozen input -- the same source deriveBindingStrength() itself uses)
  // against the independently observed payer. Deliberately independent of
  // whether a Commerce receipt exists yet (an observation alone is
  // enough), and deliberately does NOT fall back to
  // execution.expected_payer (the execution binding's own, caller-supplied
  // field, never cross-validated against this frozen commitment) -- see
  // this file's header and investigation.ts's Investigation.preflight.expected_payer doc comment.
  if (preflight.expected_payer && settlement.payer && !addressesEqual(preflight.expected_payer, settlement.payer)) {
    findings.push({
      code: 'EXPECTED_PAYER_MISMATCH',
      severity: 'critical',
      category: 'settlement',
      title: 'Observed payer does not match the frozen expected_payer commitment',
      summary: `The independently observed payer (${settlement.payer}) differs from the expected_payer frozen in the preflight policy commitment (${preflight.expected_payer}). This is a distinct commitment from the preflight action's sender field.`,
      evidence_refs: refs(preflight.receipt_id, receiptId(receipts.commerce), settlement.transaction_hash),
      recommended_action: 'Review the transaction before treating this operation as reconciled. Do not assume intent -- this records a factual mismatch against the frozen expected_payer commitment.',
    })
  }

  // --- SETTLEMENT_NOT_CONFIRMED (settlement category) ---------------------
  // Honest wording only: a transaction is KNOWN but settlement is not
  // (yet) independently confirmed -- never described as a failed payment
  // unless the evidence actually proves that.
  if (execution.transaction_hash && settlement.settlement_state !== 'CONFIRMED') {
    findings.push({
      code: 'SETTLEMENT_NOT_CONFIRMED',
      severity: 'warning',
      category: 'settlement',
      title: 'A transaction is known, but settlement is not yet independently confirmed',
      summary: `A transaction hash is known (${execution.transaction_hash}), but OCD's independent settlement check currently reports "${settlement.settlement_state ?? 'not yet evaluated'}", not CONFIRMED. This is not evidence the payment failed -- only that confirmation has not (yet) completed.`,
      evidence_refs: refs(execution.transaction_hash, settlement.settlement_state ?? undefined),
      recommended_action: recovery.needs_attention ? recovery.safe_next_action : 'Re-check settlement shortly, or call observe/finalize again for this operation.',
    })
  }

  // --- WEAK_ATTRIBUTION (evidence category) -------------------------------
  // Deliberately informational, never a warning: TRANSFER_MATCH_ONLY is an
  // honest, conservative claim level, not a defect.
  const settlementIndependentlyConfirmed = operation.observation_state === 'confirmed' || settlement.settlement_state === 'CONFIRMED'
  if (settlementIndependentlyConfirmed && evidence.binding_strength === 'TRANSFER_MATCH_ONLY') {
    findings.push({
      code: 'WEAK_ATTRIBUTION',
      severity: 'info',
      category: 'evidence',
      title: 'Conservative payment attribution',
      summary: 'Settlement was independently observed on-chain, but the strongest available attribution is TRANSFER_MATCH_ONLY -- a conservative exact-field transfer match, not direct provider-to-transaction proof or a matched on-chain payment authorization. This is expected for some executors and is not itself an error.',
      evidence_refs: refs(settlement.transaction_hash, evidence.bundle_digest, execution.executor_identity ? `${execution.executor_identity}/${execution.executor_version}` : null),
      recommended_action: null,
    })
  }

  // --- MERCHANT_RESPONSE_ERROR (settlement category) ----------------------
  // Claim discipline (D2.9A Section 7): the payment settlement may be
  // independently observed by OCD; the merchant response, in this first
  // slice, is CALLER_REPORTED evidence -- never claimed as independently
  // verified. Wording below always says "caller-reported".
  const latestMerchantEvidence = merchant_response.evidence.length > 0 ? merchant_response.evidence[merchant_response.evidence.length - 1] : null
  const settlementConfirmedForMerchantChecks = operation.observation_state === 'confirmed' || settlement.settlement_state === 'CONFIRMED'
  if (settlementConfirmedForMerchantChecks && latestMerchantEvidence && latestMerchantEvidence.http_status >= 400) {
    findings.push({
      code: 'MERCHANT_RESPONSE_ERROR',
      severity: 'warning',
      category: 'settlement',
      title: 'Settlement confirmed, but the caller-reported merchant response was an error',
      summary: `Settlement was independently confirmed, but the caller-reported merchant response was HTTP ${latestMerchantEvidence.http_status} for ${latestMerchantEvidence.resource_url}. This merchant response is CALLER_REPORTED evidence, not independently verified by OCD.`,
      evidence_refs: refs(latestMerchantEvidence.evidence_id, settlement.transaction_hash, latestMerchantEvidence.execution_request_id, latestMerchantEvidence.provider_reference),
      recommended_action: 'Investigate the merchant-side error directly. The payment settled independently of whether the merchant subsequently returned an error.',
    })
  }

  // --- MERCHANT_RESPONSE_CONTRADICTION (settlement category) --------------
  // Groups evidence records that claim to describe the SAME execution
  // (matching execution_request_id, or failing that, provider_reference)
  // and flags a materially different reported outcome (HTTP status or
  // response digest) -- a contradiction between two caller-reported
  // records, never an accusation of fraud.
  const groups = new Map<string, typeof merchant_response.evidence>()
  for (const e of merchant_response.evidence) {
    const key = e.execution_request_id ?? e.provider_reference
    if (!key) continue // nothing to correlate this record against -- not grouped, never flagged
    const group = groups.get(key) ?? []
    group.push(e)
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    const distinctStatuses = new Set(group.map((e) => e.http_status))
    const distinctDigests = new Set(group.map((e) => e.body_digest))
    if (distinctStatuses.size > 1 || distinctDigests.size > 1) {
      findings.push({
        code: 'MERCHANT_RESPONSE_CONTRADICTION',
        severity: 'warning',
        category: 'settlement',
        title: 'Multiple caller-reported merchant responses for the same execution disagree',
        summary: `${group.length} caller-reported merchant response records share the same correlation (${key}) but report ${distinctStatuses.size > 1 ? `different HTTP statuses (${[...distinctStatuses].join(', ')})` : 'different response digests'}. Both records are preserved -- neither was overwritten.`,
        evidence_refs: refs(...group.map((e) => e.evidence_id)),
        recommended_action: 'Review both caller-reported records directly. This is a contradiction in reported evidence, not a determination of which (if any) is accurate.',
      })
    }
  }

  return findings
}

/**
 * D3.3B composition point. Existing D2.8 findings remain intact. Exact
 * amount/recipient duplicates are suppressed only when the D3.3 finding
 * expresses the same established condition; all distinct legacy findings
 * remain visible. Historical callers without a durable preflight context
 * retain their previous D2.8-only behaviour.
 */
export function deriveFindings(investigation: Omit<Investigation, 'findings'>, d33Context?: D33DetectionContext): Finding[] {
  const d33 = d33Context ? mapTaxonomyFindings(detectContradictions(investigation, d33Context)) : []
  const d33Codes = new Set(d33.map((finding) => finding.code))
  const legacy = deriveLegacyFindings(investigation).filter((finding) => !d33Codes.has(finding.code))
  return [...d33, ...legacy.map((finding) => ({ ...finding, finding_class: null }))]
}

export function summarizeFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'Findings: none'
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const parts: string[] = []
  if (counts.critical > 0) parts.push(`${counts.critical} critical`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning`)
  if (counts.info > 0) parts.push(`${counts.info} informational`)
  let line = `Findings: ${parts.join(', ')}`
  const highest = findings.find((f) => f.severity === 'critical') ?? findings.find((f) => f.severity === 'warning')
  if (highest) line += `\nHighest priority: ${highest.title}.`
  return line
}
