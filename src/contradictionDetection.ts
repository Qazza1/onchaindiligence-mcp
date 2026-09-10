/**
 * D3.3B runtime adapter.
 *
 * Adapts already-assembled D2.4/D2.7 evidence into the D3.3A pure taxonomy.
 * It performs no I/O and is intentionally kept separate from the taxonomy so
 * D3.3A retains one canonical meaning for every code.
 */
import { deriveTaxonomyFindings, type ReconciliationFacts, type TaxonomyFinding } from './contradictionTaxonomy.js'
import { decimalAmountToAtomicUnits } from './money.js'
import { getSupportedAsset } from './settlement.js'
import type { Finding } from './findings.js'
import type { Investigation } from './investigation.js'

export interface D33DetectionContext {
  /** Exact durable preflight journal input; never exposed by this adapter. */
  frozenPreflightInput: unknown | null
}

type PlainObject = Record<string, unknown>

function object(value: unknown): PlainObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as PlainObject : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : undefined
}

function frozenInput(context: D33DetectionContext): { action: PlainObject; policy: PlainObject } | null {
  const frozen = object(context.frozenPreflightInput)
  const input = object(frozen?.input)
  const action = object(input?.action)
  const policy = object(input?.policy)
  return action && policy ? { action, policy } : null
}

/**
 * TRANSFER_MATCH_ONLY intentionally remains unresolved for mismatch rules:
 * it can be an exact-field match without establishing that this operation
 * caused the transfer. Executor correlation or a linked payment identity is
 * the minimum currently durable attribution evidence.
 */
function attribution(binding: Investigation['evidence']['binding_strength'], hasObservation: boolean): ReconciliationFacts['attribution'] {
  if (!hasObservation) return 'ABSENT'
  return binding === 'EXECUTOR_CORRELATED' || binding === 'PAYMENT_IDENTITY_LINKED' ? 'ATTRIBUTED' : 'UNRESOLVED'
}

function stableTaxonomyOrder(a: TaxonomyFinding, b: TaxonomyFinding): number {
  const classOrder = a.finding_class === b.finding_class ? 0 : a.finding_class === 'CONTRADICTION' ? -1 : 1
  if (classOrder !== 0) return classOrder
  const codes = [
    'AMOUNT_MISMATCH', 'ASSET_MISMATCH', 'RECIPIENT_MISMATCH', 'NETWORK_MISMATCH', 'POLICY_CONSTRAINT_VIOLATION',
    'EXECUTION_STATUS_CONTRADICTION', 'SETTLEMENT_STATUS_CONTRADICTION', 'DUPLICATE_EXECUTION', 'PAYMENT_IDENTITY_MISMATCH', 'TEMPORAL_CONSTRAINT_VIOLATION',
    'EXECUTION_NOT_INDEPENDENTLY_OBSERVED', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', 'PAYMENT_IDENTITY_UNRESOLVED', 'ATTRIBUTION_UNRESOLVED', 'REQUIRED_EVIDENCE_MISSING',
  ]
  return codes.indexOf(a.code) - codes.indexOf(b.code) || JSON.stringify(a.expected).localeCompare(JSON.stringify(b.expected))
}

/** Deduplicate only exact D3.3 code/class repeats caused by several fields sharing one missing prerequisite. */
function dedupe(findings: TaxonomyFinding[]): TaxonomyFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.finding_class}:${finding.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort(stableTaxonomyOrder)
}

/** Produces D3.3A findings from evidence available in the current investigation path. */
export function detectContradictions(
  investigation: Omit<Investigation, 'findings'>,
  context: D33DetectionContext
): TaxonomyFinding[] {
  const frozen = frozenInput(context)
  if (!frozen) return [] // historical/non-lifecycle operations have no durable input journal.

  const action = frozen.action
  const policy = frozen.policy
  const network = string(action.network)
  const asset = string(action.asset)
  const amount = string(action.amount)
  const supported = network && asset ? getSupportedAsset(network, asset) : null
  const amountAtomic = amount && supported ? decimalAmountToAtomicUnits(amount, supported.decimals)?.toString() : undefined
  const hasObservation = investigation.evidence.event_identity !== null
  // A preflight that was never submitted has no observation-reconciliation
  // obligation. Do not manufacture generic missing-evidence findings.
  if (!hasObservation) return []

  const facts: ReconciliationFacts = {
    attribution: attribution(investigation.evidence.binding_strength, hasObservation),
    evidence_refs: [
      investigation.preflight.receipt_id,
      investigation.evidence.bundle_digest,
      investigation.settlement.transaction_hash,
      investigation.execution.execution_request_id,
    ].filter((value): value is string => typeof value === 'string'),
    mandate: {
      amount_atomic: amountAtomic,
      asset,
      recipient: string(action.recipient),
      network,
    },
    observation: hasObservation ? {
      amount_atomic: investigation.settlement.amount_atomic ?? undefined,
      asset: investigation.settlement.asset ?? undefined,
      recipient: investigation.settlement.recipient ?? undefined,
      network: investigation.settlement.network ?? undefined,
    } : undefined,
    // These are the only existing, explicit payment constraints that D3.3A
    // can evaluate with current observation fields. allowed_assets remains
    // represented by ASSET_MISMATCH; it has no distinct D3.3A policy rule.
    policy: {
      max_amount_atomic: (() => {
        const maximum = string(policy.max_amount)
        return maximum && supported ? decimalAmountToAtomicUnits(maximum, supported.decimals)?.toString() : undefined
      })(),
      recipient_allowlist: string(policy.expected_recipient) ? [string(policy.expected_recipient)!] : undefined,
      allowed_networks: strings(policy.allowed_networks),
    },
  }

  return dedupe(deriveTaxonomyFindings(facts))
}

/** Maps internal D3.3A records into the existing public-safe Finding shape, preserving the canonical class for compatible consumers. */
export function mapTaxonomyFindings(findings: TaxonomyFinding[]): Finding[] {
  return findings.map((finding) => ({
    finding_class: finding.finding_class,
    code: finding.code,
    severity: finding.finding_class === 'CONTRADICTION' ? 'critical' : 'warning',
    category: finding.code.includes('POLICY') ? 'policy' : finding.code.includes('EXECUTION') ? 'execution' : finding.code.includes('IDENTITY') || finding.code.includes('ATTRIBUTION') || finding.code.includes('EVIDENCE') ? 'evidence' : 'settlement',
    title: finding.code.replace(/_/g, ' '),
    summary: finding.explanation,
    evidence_refs: finding.evidence_refs,
    recommended_action: finding.finding_class === 'CONTRADICTION' ? 'Review the relevant evidence before treating this operation as reconciled. This records an evidence disagreement, not intent.' : 'Obtain or re-check the missing independent evidence before drawing a conclusion.',
  }))
}
