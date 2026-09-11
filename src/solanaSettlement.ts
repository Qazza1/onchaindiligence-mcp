/**
 * Solana canonical-USDC observation (D3.5C4).
 *
 * This is deliberately separate from the EVM observer. It consumes Solana
 * JSON-RPC's finalized `getTransaction` response and supports only Circle's
 * native SPL-Token USDC mint on mainnet. It never treats a token-account
 * address as a wallet recipient: both accounts are resolved independently.
 */
import type { FinalityEvaluation } from './finality.js'
import { SOLANA_FINALITY_POLICY } from './finality.js'
import type { SettlementObservation, ObservedTransfer } from './settlement.js'

export const SOLANA_CAIP2 = 'solana:mainnet'
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/

export function isValidSolanaSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 64 && value.length <= 88 && BASE58_PATTERN.test(value)
}

export function isValidSolanaAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 44 && BASE58_PATTERN.test(value)
}

export function getSolanaSupportedAsset(network: string, mint: string): { decimals: number; symbol: string } | null {
  return network === SOLANA_CAIP2 && mint === SOLANA_USDC_MINT ? { decimals: 6, symbol: 'USDC' } : null
}

export interface SolanaRpcClient {
  request: (method: string, params: unknown[]) => Promise<any>
}

function getSolanaClient(): SolanaRpcClient {
  const url = process.env.SOLANA_RPC_URL
  if (!url) throw new Error('SOLANA_RPC_URL is required for Solana settlement observation')
  return {
    async request(method, params) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`)
      const body = await response.json() as { error?: { message?: string }; result?: unknown }
      if (body.error) throw new Error(`Solana RPC error: ${body.error.message ?? 'unknown error'}`)
      return body.result
    },
  }
}

function timestamp(blockTime: unknown): string | null {
  return typeof blockTime === 'number' && Number.isFinite(blockTime) ? new Date(blockTime * 1000).toISOString() : null
}

function normalizedInstructionIndex(parentIndex: number, innerIndex: number | null): number {
  // The existing storage natural key calls this a log index. For Solana it is
  // a reversible deterministic event ordinal: parent*1000 for a top-level
  // instruction, parent*1000+(inner+1) for an inner instruction. The full
  // normalized observation/bundle also carries the explicit indexes; no
  // schema migration is needed just to rename an already-generic integer.
  return parentIndex * 1000 + (innerIndex === null ? 0 : innerIndex + 1)
}

async function resolveTokenAccount(client: SolanaRpcClient, account: string): Promise<{ owner: string; mint: string } | null> {
  const result = await client.request('getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'finalized' }])
  const value = result?.value
  const info = value?.data?.parsed?.info
  if (value?.owner !== SPL_TOKEN_PROGRAM || typeof info?.owner !== 'string' || typeof info?.mint !== 'string') return null
  return { owner: info.owner, mint: info.mint }
}

interface CandidateInstruction {
  parentIndex: number
  innerIndex: number | null
  source: string
  destination: string
  mint: string | null
}

function candidatesFromTransaction(result: any): CandidateInstruction[] {
  const top = Array.isArray(result?.transaction?.message?.instructions) ? result.transaction.message.instructions : []
  const groups = Array.isArray(result?.meta?.innerInstructions) ? result.meta.innerInstructions : []
  const flattened: Array<{ instruction: any; parentIndex: number; innerIndex: number | null }> = top.map((instruction: any, parentIndex: number) => ({ instruction, parentIndex, innerIndex: null }))
  for (const group of groups) {
    if (!Number.isInteger(group?.index) || !Array.isArray(group?.instructions)) continue
    group.instructions.forEach((instruction: any, innerIndex: number) => flattened.push({ instruction, parentIndex: group.index, innerIndex }))
  }
  return flattened.flatMap(({ instruction, parentIndex, innerIndex }) => {
    const parsed = instruction?.parsed
    const info = parsed?.info
    if (instruction?.programId !== SPL_TOKEN_PROGRAM || (parsed?.type !== 'transfer' && parsed?.type !== 'transferChecked')) return []
    if (typeof info?.source !== 'string' || typeof info?.destination !== 'string') return []
    return [{ parentIndex, innerIndex, source: info.source, destination: info.destination, mint: typeof info?.mint === 'string' ? info.mint : null }]
  })
}

const NOT_FOUND: SettlementObservation = {
  state: 'not-found', blockNumber: null, blockTimestamp: null, confirmations: null,
  sufficientlyConfirmed: false, transfers: [], rpcError: null, paymentAuthorization: null, finality: null,
}

/** Read-only canonical Circle-USDC observation at Solana `finalized` commitment. */
export async function observeSolanaTransaction(
  signature: string,
  network: string,
  mint: string,
  deps: { client?: SolanaRpcClient } = {}
): Promise<SettlementObservation> {
  if (network !== SOLANA_CAIP2 || !getSolanaSupportedAsset(network, mint)) {
    throw new Error(`Solana settlement observation does not support network "${network}" / mint "${mint}"`)
  }
  if (!isValidSolanaSignature(signature)) throw new Error('Solana transaction signature must be a base58 signature')
  let client: SolanaRpcClient
  try { client = deps.client ?? getSolanaClient() } catch (err: any) {
    return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: err?.message ?? 'Solana RPC configuration unavailable' }
  }
  let transaction: any
  try {
    transaction = await client.request('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
  } catch (err: any) {
    return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: err?.message ?? 'Solana RPC error fetching transaction' }
  }
  if (transaction === null) return NOT_FOUND
  const slot = transaction?.slot
  if (!Number.isSafeInteger(slot)) return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: 'Solana RPC response had no valid slot' }
  if (transaction?.meta?.err !== null && transaction?.meta?.err !== undefined) {
    return { ...NOT_FOUND, state: 'reverted', blockNumber: BigInt(slot), blockTimestamp: timestamp(transaction.blockTime) }
  }

  const transfers: ObservedTransfer[] = []
  try {
    for (const candidate of candidatesFromTransaction(transaction)) {
      if (candidate.mint !== null && candidate.mint !== mint) continue
      const [source, destination] = await Promise.all([resolveTokenAccount(client, candidate.source), resolveTokenAccount(client, candidate.destination)])
      // For unchecked transfers, account resolution establishes the mint. For
      // checked transfers it additionally protects against a misleading parsed
      // instruction. Missing ownership evidence is omitted, never guessed.
      if (!source || !destination || source.mint !== mint || destination.mint !== mint) continue
      const instruction = candidate.innerIndex === null
        ? transaction.transaction.message.instructions[candidate.parentIndex]
        : transaction.meta.innerInstructions.find((group: any) => group.index === candidate.parentIndex)?.instructions[candidate.innerIndex]
      const amount = instruction?.parsed?.info?.tokenAmount?.amount ?? instruction?.parsed?.info?.amount
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue
      transfers.push({
        assetContract: mint,
        from: source.owner,
        to: destination.owner,
        amountAtomic: BigInt(amount),
        blockHash: '',
        transactionHash: signature,
        logIndex: normalizedInstructionIndex(candidate.parentIndex, candidate.innerIndex),
        sourceAccount: candidate.source,
        destinationAccount: candidate.destination,
        instructionIndex: candidate.parentIndex,
        innerInstructionIndex: candidate.innerIndex,
      })
    }
  } catch (err: any) {
    return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: err?.message ?? 'Solana RPC error resolving token accounts' }
  }

  try {
    const [selectedBlock, finalizedSlot] = await Promise.all([
      client.request('getBlock', [slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false }]),
      client.request('getSlot', [{ commitment: 'finalized' }]),
    ])
    if (!selectedBlock?.blockhash || !Number.isSafeInteger(finalizedSlot)) throw new Error('Solana finalized block identity unavailable')
    const finalizedHeadBlock =
      finalizedSlot === slot
        ? selectedBlock
        : await client.request('getBlock', [finalizedSlot, { commitment: 'finalized', transactionDetails: 'none', rewards: false }])
    if (!finalizedHeadBlock?.blockhash) throw new Error('Solana finalized head identity unavailable')
    const finality: FinalityEvaluation = {
      policy: SOLANA_FINALITY_POLICY,
      state: slot <= finalizedSlot ? 'safe' : 'pending',
      chainHeadUsed: { tag: 'finalized', number: String(finalizedSlot), hash: finalizedHeadBlock.blockhash },
      selectedBlock: { number: String(slot), hash: selectedBlock.blockhash },
    }
    for (const transfer of transfers) transfer.blockHash = selectedBlock.blockhash
    return {
      state: 'success', blockNumber: BigInt(slot), blockTimestamp: timestamp(transaction.blockTime), confirmations: null,
      sufficientlyConfirmed: finality.state === 'safe', transfers, rpcError: null, paymentAuthorization: null, finality,
    }
  } catch (err: any) {
    return {
      state: 'success', blockNumber: BigInt(slot), blockTimestamp: timestamp(transaction.blockTime), confirmations: null,
      sufficientlyConfirmed: false, transfers, rpcError: err?.message ?? 'Solana finalized block lookup failed', paymentAuthorization: null,
      finality: { policy: SOLANA_FINALITY_POLICY, state: 'unverifiable', chainHeadUsed: null, selectedBlock: { number: String(slot), hash: '' } },
    }
  }
}
