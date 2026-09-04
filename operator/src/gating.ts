/**
 * gating.ts — pure UI-state decision logic for the operator commerce page
 * (D2.2B). Deliberately has no DOM/window/wallet dependency so it is
 * unit-testable in plain Node, and is the single place that decides whether
 * the "Execute lifecycle" button may be enabled or a failed target-service
 * step may be safely retried.
 */
import { AGGREGATE_MAX_ATOMIC } from '../../src/lifecycleCore.js'

export const BASE_CHAIN_ID = 8453

export type InspectionStatus = 'idle' | 'pending' | 'ALLOW' | 'BLOCKED' | 'ERROR'

export interface LifecycleUiState {
  walletConnected: boolean
  chainId: number | null
  inspectionStatus: InspectionStatus
  confirmed: boolean
  usdcBalanceAtomic: bigint | null
}

export interface GateVerdict {
  allowed: boolean
  reasons: string[]
}

/** Every reason the "Execute lifecycle" action is currently disabled. Empty array means it may run. */
export function canExecuteLifecycle(state: LifecycleUiState): GateVerdict {
  const reasons: string[] = []
  if (!state.walletConnected) reasons.push('wallet not connected')
  if (state.chainId !== BASE_CHAIN_ID) reasons.push('wallet is not on Base mainnet')
  if (state.inspectionStatus !== 'ALLOW') reasons.push('free inspection has not returned ALLOW')
  if (!state.confirmed) reasons.push('operator has not confirmed the payment plan')
  if (state.usdcBalanceAtomic === null) reasons.push('USDC balance not yet known')
  else if (state.usdcBalanceAtomic < AGGREGATE_MAX_ATOMIC) reasons.push('insufficient USDC balance for both $0.01 payments')
  return { allowed: reasons.length === 0, reasons }
}

/**
 * Whether payment #2 (the target service) failed BEFORE any wallet signature
 * could have been requested for it — the only condition under which no
 * settlement could possibly have occurred, and an automatic "Retry target
 * step" button is safe to offer. Any failure at or after the signature
 * request point is ambiguous (the wallet may have produced and even
 * broadcast a payment authorization) and must require manual review instead.
 */
export type TargetStepFailurePoint = 'before-signature-requested' | 'after-signature-requested' | null

export function canRetryTargetStep(failurePoint: TargetStepFailurePoint): boolean {
  return failurePoint === 'before-signature-requested'
}
