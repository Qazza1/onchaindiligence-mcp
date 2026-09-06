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

export type FindingSeverity = 'info' | 'warning' | 'critical'
export type FindingCategory = 'policy' | 'execution' | 'settlement' | 'evidence' | 'receipt' | 'recovery'

export interface Finding {
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

/**
 * Pure and deterministic: same Investigation in, same Finding[] out, every
 * time. Bounded by construction -- one rule contributes at most one
 * finding, and there are a fixed, small number of rules.
 *
 * Takes the investigation WITHOUT its own `findings` field -- this is what
 * computes that field, so it necessarily runs before `findings` exists on
 * the object being assembled (see investigation.ts's getInvestigationForOwner()).
 */
export function deriveFindings(investigation: Omit<Investigation, 'findings'>): Finding[] {
  const findings: Finding[] = []
  const { operation, preflight, execution, settlement, evidence, receipts, recovery } = investigation

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

  // --- EXPECTED_PAYER_MISMATCH / RECIPIENT_MISMATCH / AMOUNT_MISMATCH -----
  // Reused directly from the Commerce receipt's own *-matches-preflight
  // checks (commerceReceipt.ts) rather than re-comparing raw fields here --
  // those checks already handle unit conversion (preflight amounts are
  // decimal, observed amounts are atomic) correctly; re-deriving that
  // comparison in this module would risk a unit-mismatch bug and would
  // duplicate existing lifecycle logic, which Section 1 explicitly says not
  // to do.
  const mismatchChecks: Array<{ code: string; checkId: string; title: string; fieldLabel: string }> = [
    { code: 'EXPECTED_PAYER_MISMATCH', checkId: 'sender-matches-preflight', title: 'Observed payer does not match the payer required by preflight', fieldLabel: 'payer' },
    { code: 'RECIPIENT_MISMATCH', checkId: 'recipient-matches-preflight', title: 'Observed recipient does not match the recipient proposed in preflight', fieldLabel: 'recipient' },
    { code: 'AMOUNT_MISMATCH', checkId: 'amount-matches-preflight', title: 'Observed amount does not match the amount proposed in preflight', fieldLabel: 'amount' },
  ]
  for (const { code, checkId, title, fieldLabel } of mismatchChecks) {
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

  return findings
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
