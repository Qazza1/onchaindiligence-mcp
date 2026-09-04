/**
 * commerceReceipt.ts — builds the COMMERCE receipt from a bound PREFLIGHT
 * receipt and an independently observed settlement (D2.2).
 *
 * "Settlement CONFIRMED" and "authorized execution matched" are kept
 * strictly separate: `settlement-confirmed` records whether the OBSERVED
 * transaction itself settled; the five `*-matches-preflight` checks (plus
 * the synthesizing `execution-matches-preflight`) record whether what
 * settled is the SAME thing the PREFLIGHT receipt proposed. A transaction
 * can settle (confirmed) while paying the wrong recipient or the wrong
 * amount — that mismatch is captured, not hidden, and settlement-confirmed
 * for that case is FAIL precisely because the position OCD proposed did not
 * settle, even though something else on that contract did.
 *
 * `decision` is copied verbatim from the original PREFLIGHT receipt — this
 * receipt never re-runs policy evaluation, and never implies it did.
 */
import { getSupportedAsset, type SettlementObservation, type ObservedTransfer } from './settlement.js'
import { decimalAmountToAtomicUnits, atomicUnitsToDecimalAmount } from './money.js'
import type { Receipt, ReceiptCheck, ReceiptAction, ReceiptExecution, ReceiptSettlement } from './receipts.js'

export interface FinalizationExecutionInput {
  transaction_hash: `0x${string}`
  execution_provider: 'x402' | 'paybox' | 'wallet' | 'other'
  provider_reference: string | null
  result_digest: string | null
}

function addressesEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

function pickObservedTransfer(
  transfers: ObservedTransfer[],
  preflightRecipient: string,
  preflightAmountAtomic: bigint | null,
  preflightSender: string | null
): ObservedTransfer | null {
  if (transfers.length === 0) return null
  const exact = transfers.find(
    (t) =>
      addressesEqual(t.to, preflightRecipient) &&
      preflightAmountAtomic !== null &&
      t.amountAtomic === preflightAmountAtomic &&
      (preflightSender === null || addressesEqual(t.from, preflightSender))
  )
  if (exact) return exact
  const recipientMatch = transfers.find((t) => addressesEqual(t.to, preflightRecipient))
  if (recipientMatch) return recipientMatch
  // No recipient match at all — report the largest transfer of the expected
  // asset as the most representative "what actually happened here" fact.
  return transfers.reduce((largest, t) => (t.amountAtomic > largest.amountAtomic ? t : largest), transfers[0]!)
}

export interface BuiltCommerceReceiptCore {
  action: ReceiptAction
  execution: ReceiptExecution
  settlement: ReceiptSettlement
  checks: ReceiptCheck[]
  limitations: string[]
}

/**
 * Pure function: given the bound preflight receipt and an already-gathered
 * settlement observation, deterministically builds every field of the new
 * COMMERCE receipt core EXCEPT receipt_type/issued_at/links (added by the
 * caller, see finalizeRoute.ts) — no network access here.
 */
export function buildCommerceReceiptCore(
  preflightReceipt: Receipt,
  execution: FinalizationExecutionInput,
  observation: SettlementObservation
): BuiltCommerceReceiptCore {
  const checks: ReceiptCheck[] = []
  const pf = preflightReceipt.action
  const asset = getSupportedAsset(pf.network ?? '', pf.asset ?? '')
  const preflightAmountAtomic =
    asset && pf.amount !== null ? decimalAmountToAtomicUnits(pf.amount, asset.decimals) : null

  checks.push({
    id: 'preflight-receipt-valid',
    result: 'PASS', // finalizeRoute.ts rejects before reaching here if the bound preflight receipt does not verify VALID
    summary: 'The finalization capability is bound to a PREFLIGHT receipt whose signature independently verifies VALID.',
    evidence_digest: preflightReceipt.receipt_digest,
  })

  const found = observation.state === 'success' || observation.state === 'reverted'
  checks.push({
    id: 'transaction-found',
    result: found ? 'PASS' : observation.state === 'rpc-unavailable' ? 'UNKNOWN' : 'FAIL',
    summary:
      observation.state === 'not-found'
        ? 'No transaction was found on Base mainnet for the supplied hash at inspection time.'
        : observation.state === 'rpc-unavailable'
          ? `The Base RPC endpoint could not be reached to look up the transaction: ${observation.rpcError ?? 'unknown error'}.`
          : 'A transaction matching the supplied hash was found on Base mainnet.',
    evidence_digest: null,
  })

  checks.push({
    id: 'transaction-success',
    result: !found ? 'NOT_CHECKED' : observation.state === 'success' ? 'PASS' : 'FAIL',
    summary: !found
      ? 'Not evaluated: the transaction was not found.'
      : observation.state === 'success'
        ? 'The transaction executed successfully on-chain (did not revert).'
        : 'The transaction reverted on-chain.',
    evidence_digest: null,
  })

  const chosen =
    observation.state === 'success'
      ? pickObservedTransfer(observation.transfers, pf.recipient ?? '', preflightAmountAtomic, pf.sender)
      : null

  const matchCheck = (
    id: string,
    matched: boolean | 'not-applicable',
    passSummary: string,
    failSummary: string
  ): ReceiptCheck => ({
    id,
    result: observation.state !== 'success' ? 'NOT_CHECKED' : matched === 'not-applicable' ? 'NOT_CHECKED' : matched ? 'PASS' : 'FAIL',
    summary: observation.state !== 'success' ? 'Not evaluated: the transaction did not confirm successfully.' : matched === true ? passSummary : matched === 'not-applicable' ? 'No preflight constraint was set for this field.' : failSummary,
    evidence_digest: null,
  })

  checks.push(
    matchCheck(
      'network-matches-preflight',
      pf.network === 'eip155:8453',
      'The observed settlement network matches the network proposed in the preflight.',
      'The observed settlement network does not match the network proposed in the preflight.'
    )
  )
  checks.push(
    matchCheck(
      'asset-matches-preflight',
      observation.transfers.length > 0,
      'A transfer of the exact asset contract proposed in the preflight was observed in this transaction.',
      'No transfer of the asset contract proposed in the preflight was observed in this transaction.'
    )
  )
  checks.push(
    matchCheck(
      'recipient-matches-preflight',
      chosen !== null && addressesEqual(chosen.to, pf.recipient),
      'The observed recipient matches the recipient proposed in the preflight.',
      'The observed recipient does not match the recipient proposed in the preflight.'
    )
  )
  checks.push(
    matchCheck(
      'amount-matches-preflight',
      chosen !== null && preflightAmountAtomic !== null && chosen.amountAtomic === preflightAmountAtomic,
      'The observed amount matches the amount proposed in the preflight.',
      'The observed amount does not match the amount proposed in the preflight.'
    )
  )
  checks.push(
    matchCheck(
      'sender-matches-preflight',
      pf.sender === null ? 'not-applicable' : chosen !== null && addressesEqual(chosen.from, pf.sender),
      'The observed sender matches the sender required by the preflight.',
      'The observed sender does not match the sender required by the preflight.'
    )
  )

  const matchResults = checks.slice(-5).map((c) => c.result)
  const anyMatchFail = matchResults.includes('FAIL')
  const allApplicableMatchPass = matchResults.every((r) => r === 'PASS' || r === 'NOT_CHECKED')
  checks.push({
    id: 'execution-matches-preflight',
    result: observation.state !== 'success' ? 'NOT_CHECKED' : anyMatchFail ? 'FAIL' : allApplicableMatchPass ? 'PASS' : 'FAIL',
    summary:
      observation.state !== 'success'
        ? 'Not evaluated: the transaction did not confirm successfully.'
        : anyMatchFail || !allApplicableMatchPass
          ? 'The observed settlement does not match what the preflight proposed on at least one field — see the individual *-matches-preflight checks.'
          : 'The observed settlement matches every field the preflight proposed.',
    evidence_digest: null,
  })

  const exactMatch = observation.state === 'success' && !anyMatchFail && allApplicableMatchPass
  const settlementConfirmed = exactMatch && observation.sufficientlyConfirmed
  checks.push({
    id: 'settlement-confirmed',
    result:
      observation.state === 'rpc-unavailable'
        ? 'UNKNOWN'
        : observation.state === 'success' && !observation.sufficientlyConfirmed
          ? 'UNKNOWN'
          : settlementConfirmed
            ? 'PASS'
            : 'FAIL',
    summary: settlementConfirmed
      ? 'The exact payment proposed in the preflight was independently observed settled on-chain.'
      : observation.state === 'success' && !observation.sufficientlyConfirmed
        ? 'The transaction was observed but has not yet reached the required confirmation depth.'
        : 'The exact payment proposed in the preflight was not confirmed settled — see the match checks above for the specific discrepancy, if any.',
    evidence_digest: null,
  })

  checks.push({
    id: 'service-delivery-verification',
    result: 'NOT_CHECKED',
    summary: execution.result_digest
      ? 'A result digest was supplied by the caller. This is a caller-provided claim only — OnChainDiligence did not independently observe or verify service/resource delivery.'
      : 'Not evaluated: no result digest was supplied, and OnChainDiligence does not independently observe service/resource delivery in v1.',
    evidence_digest: execution.result_digest ?? null,
  })

  const executionStatus: ReceiptExecution['status'] =
    observation.state === 'not-found' || observation.state === 'rpc-unavailable'
      ? 'UNKNOWN'
      : observation.state === 'reverted'
        ? 'FAILED'
        : 'CONFIRMED'

  const settlementStatus: ReceiptSettlement['status'] =
    observation.state === 'not-found' || observation.state === 'rpc-unavailable'
      ? 'UNVERIFIED'
      : observation.state === 'reverted'
        ? 'NOT_CONFIRMED'
        : !observation.sufficientlyConfirmed
          ? 'UNVERIFIED'
          : settlementConfirmed
            ? 'CONFIRMED'
            : 'NOT_CONFIRMED'

  const action: ReceiptAction = {
    kind: 'PAYMENT',
    resource: pf.resource,
    network: pf.network,
    asset: pf.asset,
    amount: chosen ? atomicUnitsToDecimalAmount(chosen.amountAtomic, asset?.decimals ?? 0) : null,
    sender: chosen ? chosen.from : pf.sender,
    recipient: chosen ? chosen.to : null,
  }

  const executionRecord: ReceiptExecution = {
    provider: execution.execution_provider,
    status: executionStatus,
    transaction_hash: execution.transaction_hash,
    submitted_at: null, // not independently observable; only the settlement block time is
    confirmed_at: settlementStatus === 'CONFIRMED' ? observation.blockTimestamp : null,
  }

  const settlementRecord: ReceiptSettlement = {
    status: settlementStatus,
    detail: settlementConfirmed
      ? 'Independently observed on Base mainnet: the proposed transfer settled exactly as preflighted.'
      : observation.state === 'success' && !exactMatch
        ? 'A transaction was observed and confirmed, but it did not match the payment proposed in the preflight — see checks for the exact discrepancy.'
        : observation.state === 'reverted'
          ? 'The observed transaction reverted; no value moved.'
          : observation.state === 'not-found'
            ? 'No transaction was found for the supplied hash at inspection time.'
            : 'Settlement could not be independently verified (RPC unavailable, or insufficient confirmations).',
  }

  const limitations = [
    'This receipt records the OBSERVED execution and settlement; `decision` is copied unchanged from the original PREFLIGHT receipt and was not re-evaluated here.',
    'A transaction hash was supplied by the caller; OnChainDiligence independently inspected Base mainnet rather than trusting the caller, PayBox, or any x402 facilitator report of success.',
    'v1 settlement verification supports Base mainnet USDC ERC-20 transfers only.',
    'service-delivery-verification is NOT_CHECKED in v1: a caller-supplied result digest, where present, is recorded as a claim only, not independently verified.',
    'No identity is inferred for the sender or recipient wallet beyond the address itself.',
  ]

  return { action, execution: executionRecord, settlement: settlementRecord, checks, limitations }
}
