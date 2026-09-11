/**
 * D3.3A contradiction vocabulary and deterministic reconciliation rules.
 *
 * This module is deliberately internal and inert: it is not wired into a
 * receipt, API, MCP tool, or UI yet. D3.3B will adapt assembled lifecycle
 * evidence into ReconciliationFacts. Keeping that adapter separate prevents
 * this vocabulary from changing the frozen Action Receipt v1 contract.
 *
 * A contradiction is emitted only when sufficient evidence establishes that
 * two relevant facts disagree. Missing or unresolved evidence is not a
 * contradiction.
 */

import { isValidSolanaAddress } from './inputValidation.js'

export const CONTRADICTION_CODES = [
  'AMOUNT_MISMATCH',
  'ASSET_MISMATCH',
  'RECIPIENT_MISMATCH',
  'NETWORK_MISMATCH',
  'POLICY_CONSTRAINT_VIOLATION',
  'EXECUTION_STATUS_CONTRADICTION',
  'SETTLEMENT_STATUS_CONTRADICTION',
  'DUPLICATE_EXECUTION',
  'PAYMENT_IDENTITY_MISMATCH',
  'TEMPORAL_CONSTRAINT_VIOLATION',
  // D3.6A: recipient/amount are payment-specific and would misdescribe an
  // ERC-20 approval. These two are used only by the allowance reconciler.
  'SPENDER_MISMATCH',
  'ALLOWANCE_MISMATCH',
  'ROUTER_MISMATCH',
  'OUTPUT_ASSET_MISMATCH',
  'MINIMUM_OUTPUT_NOT_MET',
] as const

export const INSUFFICIENT_EVIDENCE_CODES = [
  'EXECUTION_NOT_INDEPENDENTLY_OBSERVED',
  'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED',
  'PAYMENT_IDENTITY_UNRESOLVED',
  'ATTRIBUTION_UNRESOLVED',
  'REQUIRED_EVIDENCE_MISSING',
] as const

export type ContradictionCode = (typeof CONTRADICTION_CODES)[number]
export type InsufficientEvidenceCode = (typeof INSUFFICIENT_EVIDENCE_CODES)[number]
export type TaxonomyFindingCode = ContradictionCode | InsufficientEvidenceCode
export type FindingClass = 'CONTRADICTION' | 'INSUFFICIENT_EVIDENCE'

/** Existing evidence roles, not a replacement evidence graph. */
export type EvidenceSource =
  | 'MANDATE'
  | 'POLICY'
  | 'DECISION'
  | 'EXECUTOR_CLAIM'
  | 'CHAIN_OBSERVATION'
  | 'SETTLEMENT_OBSERVATION'
  | 'PAYMENT_PROVIDER_EVIDENCE'
  | 'RECEIPT'
  | 'BINDING_EVIDENCE'

export interface TaxonomyFinding {
  finding_class: FindingClass
  code: TaxonomyFindingCode
  /** Machine-readable facts; null is never represented as a positive mismatch. */
  expected: unknown
  observed: unknown
  evidence_refs: string[]
  evidence_sources: EvidenceSource[]
  explanation: string
}

export type Attribution = 'ATTRIBUTED' | 'UNRESOLVED' | 'ABSENT'
export type BindingStrength = 'TRANSFER_MATCH_ONLY' | 'EXECUTOR_CORRELATED' | 'PAYMENT_IDENTITY_LINKED'
export type ExecutionStatus = 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
export type SettlementStatus = 'CONFIRMED' | 'NOT_CONFIRMED' | 'UNVERIFIED' | 'NOT_APPLICABLE'

export interface ReconciliationFacts {
  /** Attribution must be established before payment-field comparisons. */
  attribution: Attribution
  evidence_refs?: string[]
  mandate?: { amount_atomic?: string; asset?: string; recipient?: string; network?: string; payment_identity?: string; deadline?: string | null }
  observation?: {
    amount_atomic?: string
    asset?: string
    recipient?: string
    network?: string
    payment_identity?: string
    execution_at?: string | null
    /** Stable, network-specific identities. Repeated copies of one identity are not duplicates. */
    execution_ids?: string[]
  }
  policy?: { max_amount_atomic?: string; recipient_allowlist?: string[]; allowed_networks?: string[] }
  executor_claim?: { execution_status?: ExecutionStatus; settlement_status?: SettlementStatus }
  independent?: { execution_status?: ExecutionStatus; settlement_status?: SettlementStatus }
  /** Receipt proof is deliberately not a reconciliation input: UNVERIFIABLE alone is not a contradiction. */
  receipt_verification?: 'VALID' | 'INVALID' | 'UNVERIFIABLE'
  binding_strength?: BindingStrength | null
  only_one_execution_authorized?: boolean
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC_AMOUNT = /^(0|[1-9][0-9]*)$/
const CAIP2 = /^([a-z0-9][a-z0-9-]{0,31}):([A-Za-z0-9-]{1,32})$/
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export function normalizeEvmAddress(value: string): string | null {
  return EVM_ADDRESS.test(value) ? value.toLowerCase() : null
}

/**
 * Reconciliation addresses are chain-scoped facts. EVM addresses compare
 * case-insensitively; Solana public keys are canonical base58 and compare
 * exactly. Unknown shapes stay uncomparable rather than being normalized by
 * guesswork.
 */
export function normalizeSupportedAddress(value: string): string | null {
  const trimmed = value.trim()
  if (EVM_ADDRESS.test(trimmed)) return trimmed.toLowerCase()
  return isValidSolanaAddress(trimmed) ? trimmed : null
}

/** Canonical CAIP-2 only; display labels such as “Base” are intentionally rejected. */
export function normalizeNetwork(value: string): string | null {
  const match = CAIP2.exec(value)
  return match ? `${match[1].toLowerCase()}:${match[2]}` : null
}

/** Contract identities compare by bytes; other canonical asset identifiers compare exactly. */
export function normalizeAsset(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return EVM_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

export function normalizeAtomicAmount(value: string): bigint | null {
  return ATOMIC_AMOUNT.test(value) ? BigInt(value) : null
}

function canonicalRefs(refs: string[] | undefined): string[] {
  return [...new Set((refs ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0))].sort()
}

function finding(
  finding_class: FindingClass,
  code: TaxonomyFindingCode,
  expected: unknown,
  observed: unknown,
  evidence_sources: EvidenceSource[],
  explanation: string,
  facts: ReconciliationFacts
): TaxonomyFinding {
  return { finding_class, code, expected, observed, evidence_refs: canonicalRefs(facts.evidence_refs), evidence_sources, explanation }
}

function unresolvedForComparison(facts: ReconciliationFacts, expected: unknown, observed: unknown): TaxonomyFinding | null {
  if (facts.attribution === 'UNRESOLVED') {
    return finding('INSUFFICIENT_EVIDENCE', 'ATTRIBUTION_UNRESOLVED', expected, observed, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Possible observation cannot be deterministically attributed to this authorized operation.', facts)
  }
  if (facts.attribution !== 'ATTRIBUTED' || observed === undefined || observed === null) {
    return finding('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', expected, observed ?? null, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Required attributable independent observation is absent.', facts)
  }
  return null
}

function incompatibleTerminal(left: string | undefined, right: string | undefined): boolean {
  return (left === 'CONFIRMED' && right === 'FAILED') || (left === 'FAILED' && right === 'CONFIRMED') ||
    (left === 'CONFIRMED' && right === 'NOT_CONFIRMED') || (left === 'NOT_CONFIRMED' && right === 'CONFIRMED')
}

/**
 * Pure, time-independent and order-independent. It performs only the V1
 * rule matrix; it does not infer intent, truth, safety, fraud, or compliance.
 */
export function deriveTaxonomyFindings(facts: ReconciliationFacts): TaxonomyFinding[] {
  const output: TaxonomyFinding[] = []
  const mandate = facts.mandate ?? {}
  const observation = facts.observation ?? {}

  const compare = (
    code: ContradictionCode,
    expected: string | undefined,
    observed: string | undefined,
    normalize: (value: string) => string | bigint | null,
    label: string
  ) => {
    if (expected === undefined) return
    const unavailable = unresolvedForComparison(facts, expected, observed)
    if (unavailable) { output.push(unavailable); return }
    const left = normalize(expected)
    const right = normalize(observed as string)
    if (left === null || right === null) {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', expected, observed, ['MANDATE', 'CHAIN_OBSERVATION'], `Required ${label} value is not in a canonical comparable form.`, facts))
    } else if (left !== right) {
      output.push(finding('CONTRADICTION', code, expected, observed, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], `Authorized ${label} and independently observed attributable ${label} differ.`, facts))
    }
  }

  // Provider claims may arrive before OCD has observed the chain. Report the
  // precise terminal-status evidence gap below, not a noisy gap for every
  // mandate field that has no independent counterpart yet.
  if (facts.observation) {
    compare('AMOUNT_MISMATCH', mandate.amount_atomic, observation.amount_atomic, normalizeAtomicAmount, 'amount in atomic units')
    compare('ASSET_MISMATCH', mandate.asset, observation.asset, normalizeAsset, 'asset identity')
    compare('RECIPIENT_MISMATCH', mandate.recipient, observation.recipient, normalizeSupportedAddress, 'recipient address')
    compare('NETWORK_MISMATCH', mandate.network, observation.network, normalizeNetwork, 'network identifier')
  }

  // Explicit policy only. ALLOW on its own never enters this rule.
  if (facts.observation && facts.policy && (facts.policy.max_amount_atomic !== undefined || facts.policy.recipient_allowlist !== undefined || facts.policy.allowed_networks !== undefined)) {
    const unavailable = unresolvedForComparison(facts, facts.policy, observation)
    if (unavailable) output.push(unavailable)
    else {
      const max = facts.policy.max_amount_atomic ? normalizeAtomicAmount(facts.policy.max_amount_atomic) : null
      const amount = observation.amount_atomic ? normalizeAtomicAmount(observation.amount_atomic) : null
      if (max !== null && amount !== null && amount > max) {
        output.push(finding('CONTRADICTION', 'POLICY_CONSTRAINT_VIOLATION', { max_amount_atomic: facts.policy.max_amount_atomic }, { amount_atomic: observation.amount_atomic }, ['POLICY', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Independently observed attributable amount exceeds an explicit policy maximum.', facts))
      }
      if (facts.policy.recipient_allowlist) {
        const recipient = observation.recipient ? normalizeSupportedAddress(observation.recipient) : null
        const allowlist = facts.policy.recipient_allowlist.map(normalizeSupportedAddress)
        if (recipient !== null && allowlist.every((entry) => entry !== recipient)) {
          output.push(finding('CONTRADICTION', 'POLICY_CONSTRAINT_VIOLATION', { recipient_allowlist: facts.policy.recipient_allowlist }, { recipient: observation.recipient }, ['POLICY', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Independently observed attributable recipient is outside an explicit policy allowlist.', facts))
        }
      }
      if (facts.policy.allowed_networks) {
        const network = observation.network ? normalizeNetwork(observation.network) : null
        const allowed = facts.policy.allowed_networks.map(normalizeNetwork)
        if (network !== null && allowed.every((entry) => entry !== network)) {
          output.push(finding('CONTRADICTION', 'POLICY_CONSTRAINT_VIOLATION', { allowed_networks: facts.policy.allowed_networks }, { network: observation.network }, ['POLICY', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Independently observed attributable network is outside an explicit policy allowed-network constraint.', facts))
        }
      }
    }
  }

  const claimedExecution = facts.executor_claim?.execution_status
  const observedExecution = facts.independent?.execution_status
  if (claimedExecution === 'CONFIRMED' || claimedExecution === 'FAILED') {
    if (!observedExecution || observedExecution === 'UNKNOWN') {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'EXECUTION_NOT_INDEPENDENTLY_OBSERVED', claimedExecution, observedExecution ?? null, ['EXECUTOR_CLAIM', 'CHAIN_OBSERVATION'], 'Executor terminal claim cannot yet be independently established.', facts))
    } else if (incompatibleTerminal(claimedExecution, observedExecution)) {
      output.push(finding('CONTRADICTION', 'EXECUTION_STATUS_CONTRADICTION', claimedExecution, observedExecution, ['EXECUTOR_CLAIM', 'CHAIN_OBSERVATION'], 'Executor terminal claim and independently established terminal execution evidence disagree.', facts))
    }
  }

  const claimedSettlement = facts.executor_claim?.settlement_status
  const observedSettlement = facts.independent?.settlement_status
  if (claimedSettlement === 'CONFIRMED' || claimedSettlement === 'NOT_CONFIRMED') {
    if (!observedSettlement || observedSettlement === 'UNVERIFIED') {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED', claimedSettlement, observedSettlement ?? null, ['EXECUTOR_CLAIM', 'SETTLEMENT_OBSERVATION'], 'Claimed settlement cannot yet be independently confirmed.', facts))
    } else if (incompatibleTerminal(claimedSettlement, observedSettlement)) {
      output.push(finding('CONTRADICTION', 'SETTLEMENT_STATUS_CONTRADICTION', claimedSettlement, observedSettlement, ['EXECUTOR_CLAIM', 'SETTLEMENT_OBSERVATION'], 'Settlement claim and independently established terminal settlement evidence disagree.', facts))
    }
  }

  if (mandate.payment_identity !== undefined) {
    if (observation.payment_identity !== undefined) {
      if (facts.attribution === 'ATTRIBUTED' && mandate.payment_identity !== observation.payment_identity) {
        output.push(finding('CONTRADICTION', 'PAYMENT_IDENTITY_MISMATCH', mandate.payment_identity, observation.payment_identity, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Independently established payment identity conflicts with the expected payment identity.', facts))
      } else if (facts.attribution !== 'ATTRIBUTED') {
        output.push(unresolvedForComparison(facts, mandate.payment_identity, observation.payment_identity) as TaxonomyFinding)
      }
    } else if (facts.binding_strength === 'TRANSFER_MATCH_ONLY') {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'PAYMENT_IDENTITY_UNRESOLVED', mandate.payment_identity, facts.binding_strength, ['MANDATE', 'BINDING_EVIDENCE'], 'Transfer-only matching does not establish the expected payment identity relationship.', facts))
    } else {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', mandate.payment_identity, null, ['MANDATE', 'BINDING_EVIDENCE'], 'Required independently established payment identity is absent.', facts))
    }
  }

  if (facts.only_one_execution_authorized) {
    const ids = [...new Set((observation.execution_ids ?? []).filter((id) => typeof id === 'string' && id.length > 0))].sort()
    if (ids.length > 1 && facts.attribution === 'ATTRIBUTED') {
      output.push(finding('CONTRADICTION', 'DUPLICATE_EXECUTION', { authorized_execution_count: 1 }, { distinct_execution_ids: ids }, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'More than one distinct stable attributable execution identity was observed for a single-execution authorization.', facts))
    }
  }

  if (mandate.deadline !== undefined) {
    const unavailable = unresolvedForComparison(facts, mandate.deadline, observation.execution_at)
    if (unavailable) output.push(unavailable)
    else if (!UTC_TIMESTAMP.test(mandate.deadline ?? '') || !UTC_TIMESTAMP.test(observation.execution_at ?? '')) {
      output.push(finding('INSUFFICIENT_EVIDENCE', 'REQUIRED_EVIDENCE_MISSING', mandate.deadline, observation.execution_at ?? null, ['MANDATE', 'CHAIN_OBSERVATION'], 'Required authoritative UTC timing evidence is not in a canonical comparable form.', facts))
    } else if (Date.parse(observation.execution_at as string) > Date.parse(mandate.deadline as string)) {
      output.push(finding('CONTRADICTION', 'TEMPORAL_CONSTRAINT_VIOLATION', mandate.deadline, observation.execution_at, ['MANDATE', 'CHAIN_OBSERVATION', 'BINDING_EVIDENCE'], 'Authoritative observed execution time falls after the explicit authorized deadline.', facts))
    }
  }

  // Stable output even when callers provide arrays in a different order.
  return output.sort((a, b) => a.code.localeCompare(b.code) || JSON.stringify(a.expected).localeCompare(JSON.stringify(b.expected)))
}
