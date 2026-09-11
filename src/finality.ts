/**
 * finality.ts — named, versioned finality policy for the commerce-lifecycle
 * profile (D2.4, Section 9).
 *
 * This is ADDITIVE and does not touch settlement.ts's existing
 * confirmation-count-based `sufficientlyConfirmed` semantics, which the
 * legacy /receipts/finalize route keeps using completely unchanged (see
 * that file's header) — the four historical receipts and every existing
 * test depend on that exact, already-deployed behavior.
 *
 * `base-usdc-safe-head.v1`: an observed transfer is "safe" when its block
 * is at or behind the chain's own "safe" head, as reported by the
 * configured RPC's `safe` block tag (supported by Base, an OP-stack chain).
 * This is RPC-witnessed, not offline proof of Base consensus, and does not
 * claim permanent irreversibility — it is only as trustworthy as the RPC
 * endpoint queried, exactly like every other observation in this codebase.
 *
 * If the configured RPC does not support the `safe` tag (some public
 * endpoints don't), this NEVER silently substitutes confirmation-counting
 * under the same policy name — that would conflate two different
 * evidentiary bases under one label. It reports `state: 'unverifiable'`
 * instead, honestly, rather than fabricating a finality claim.
 */
import type { Hex } from 'viem'
import { BASE_CAIP2, ETHEREUM_CAIP2, TEMPO_CAIP2 } from './settlementNetworks.js'

export const BASE_FINALITY_POLICY = 'base-usdc-safe-head.v1'
export const ETHEREUM_FINALITY_POLICY = 'ethereum-usdc-finalized-head.v1'
export const TEMPO_FINALITY_POLICY = 'tempo-tip20-finalized-head.v1'
export const SOLANA_FINALITY_POLICY = 'solana-usdc-finalized.v1'

export type FinalityState = 'safe' | 'pending' | 'unverifiable' | 'reverted'

export interface ChainHeadUsed {
  tag: 'safe' | 'finalized'
  number: string
  hash: string
}

export interface FinalityEvaluation {
  policy: typeof BASE_FINALITY_POLICY | typeof ETHEREUM_FINALITY_POLICY | typeof TEMPO_FINALITY_POLICY | typeof SOLANA_FINALITY_POLICY
  state: FinalityState
  chainHeadUsed: ChainHeadUsed | null
  selectedBlock: { number: string; hash: string }
}

export interface MinimalFinalityClient {
  getBlock: (args: { blockTag: 'safe' | 'finalized' }) => Promise<{ number: bigint; hash: Hex }>
}

/** Ethereum uses the consensus-layer finalized head, not a confirmation count. */
export async function evaluateEthereumFinality(
  client: MinimalFinalityClient,
  selectedBlockNumber: bigint,
  selectedBlockHash: Hex
): Promise<FinalityEvaluation> {
  const selectedBlock = { number: selectedBlockNumber.toString(), hash: selectedBlockHash }
  try {
    const finalizedBlock = await client.getBlock({ blockTag: 'finalized' })
    const chainHeadUsed: ChainHeadUsed = { tag: 'finalized', number: finalizedBlock.number.toString(), hash: finalizedBlock.hash }
    const state: FinalityState = selectedBlockNumber <= finalizedBlock.number ? 'safe' : 'pending'
    return { policy: ETHEREUM_FINALITY_POLICY, state, chainHeadUsed, selectedBlock }
  } catch {
    return { policy: ETHEREUM_FINALITY_POLICY, state: 'unverifiable', chainHeadUsed: null, selectedBlock }
  }
}

/**
 * Tempo uses deterministic Simplex BFT finality. OCD still asks its configured
 * RPC for the standard `finalized` head and records that head as the evidence
 * basis; an included block is never silently treated as final merely because
 * it has confirmations.
 */
export async function evaluateTempoFinality(
  client: MinimalFinalityClient,
  selectedBlockNumber: bigint,
  selectedBlockHash: Hex
): Promise<FinalityEvaluation> {
  const selectedBlock = { number: selectedBlockNumber.toString(), hash: selectedBlockHash }
  try {
    const finalizedBlock = await client.getBlock({ blockTag: 'finalized' })
    const chainHeadUsed: ChainHeadUsed = { tag: 'finalized', number: finalizedBlock.number.toString(), hash: finalizedBlock.hash }
    const state: FinalityState = selectedBlockNumber <= finalizedBlock.number ? 'safe' : 'pending'
    return { policy: TEMPO_FINALITY_POLICY, state, chainHeadUsed, selectedBlock }
  } catch {
    return { policy: TEMPO_FINALITY_POLICY, state: 'unverifiable', chainHeadUsed: null, selectedBlock }
  }
}

/** One explicit finality-policy dispatch point for supported EVM networks. */
export async function evaluateSettlementFinality(
  network: string,
  client: MinimalFinalityClient,
  selectedBlockNumber: bigint,
  selectedBlockHash: Hex
): Promise<FinalityEvaluation> {
  if (network === BASE_CAIP2) return evaluateBaseFinality(client, selectedBlockNumber, selectedBlockHash)
  if (network === ETHEREUM_CAIP2) return evaluateEthereumFinality(client, selectedBlockNumber, selectedBlockHash)
  if (network === TEMPO_CAIP2) return evaluateTempoFinality(client, selectedBlockNumber, selectedBlockHash)
  throw new Error(`no finality policy is configured for ${network}`)
}

/**
 * Evaluates finality for one already-selected block (the block containing
 * the exact chain event under evaluation — see commerceLifecycle.ts).
 * Never called for a reverted transaction's block; callers report
 * `state: 'reverted'` directly without consulting this function in that
 * case (there is no "safe head" question to ask about a transaction that
 * never had any effect).
 */
export async function evaluateBaseFinality(
  client: MinimalFinalityClient,
  selectedBlockNumber: bigint,
  selectedBlockHash: Hex
): Promise<FinalityEvaluation> {
  const selectedBlock = { number: selectedBlockNumber.toString(), hash: selectedBlockHash }
  try {
    const safeBlock = await client.getBlock({ blockTag: 'safe' })
    const chainHeadUsed: ChainHeadUsed = { tag: 'safe', number: safeBlock.number.toString(), hash: safeBlock.hash }
    const state: FinalityState = selectedBlockNumber <= safeBlock.number ? 'safe' : 'pending'
    return { policy: BASE_FINALITY_POLICY, state, chainHeadUsed, selectedBlock }
  } catch {
    // The configured RPC does not support the `safe` tag (or the call
    // otherwise failed) -- report honestly, never fall back to a
    // differently-evidenced claim under this policy's name.
    return { policy: BASE_FINALITY_POLICY, state: 'unverifiable', chainHeadUsed: null, selectedBlock }
  }
}
