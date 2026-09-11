/**
 * settlement.ts — independent on-chain settlement verification (D2.2).
 *
 * Supported EVM scope: Base/Ethereum canonical USDC and Tempo mainnet pathUSD
 * transfers.
 * The network registry is intentionally small and explicit; this module is
 * shared transaction/receipt/log observation, not a universal chain plugin.
 *
 * OCD never trusts a caller's claim that a payment settled. This module
 * reads the transaction receipt and its logs directly from a configured EVM JSON-RPC
 * endpoint and reports only what it actually observed: whether the
 * transaction was found, whether it reverted, how many confirmations it
 * has, and every ERC-20 Transfer log emitted by the expected asset
 * contract. Matching those observed transfers against what a PREFLIGHT
 * receipt proposed is the caller's job (see commerceReceipt.ts) — this
 * module reports facts, it does not make the match/mismatch decision.
 *
 * Reuses the existing viem dependency (already used by chainalysis.ts) —
 * no second blockchain stack.
 */
import { createPublicClient, http, getAddress, parseAbi, parseEventLogs, type Log, type Hex } from 'viem'
import { decodeErc3009Authorization, type DecodedPaymentAuthorization } from './paymentAuthorization.js'
import { BASE_CAIP2, getConfiguredRpcUrl, getNetworkMinConfirmations, getSettlementNetwork } from './settlementNetworks.js'
import { SOLANA_CAIP2, getSolanaSupportedAsset, isValidSolanaSignature, observeSolanaTransaction } from './solanaSettlement.js'
import type { FinalityEvaluation } from './finality.js'

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export { BASE_CAIP2 }

export function getSupportedAsset(network: string, assetContract: string): { decimals: number; symbol: string } | null {
  return getSettlementNetwork(network)?.assets[assetContract.toLowerCase()] ?? getSolanaSupportedAsset(network, assetContract)
}

export class UnsupportedSettlementScopeError extends Error {
  constructor(network: string, assetContract: string) {
    super(
      `settlement verification does not support network "${network}" / asset "${assetContract}" in v1 — ` +
        `supported canonical assets are Base (${BASE_CAIP2}) USDC, Ethereum (eip155:1) USDC, Tempo (eip155:4217) pathUSD, and Solana (${SOLANA_CAIP2}) USDC`
    )
    this.name = 'UnsupportedSettlementScopeError'
  }
}

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

export function isValidTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && TRANSACTION_HASH_PATTERN.test(value)
}

/** A finalization transaction identifier: EVM hash or Solana base58 signature. */
export function isValidTransactionReference(value: unknown): value is string {
  return isValidTransactionHash(value) || isValidSolanaSignature(value)
}

// D2.2B2: the confirmation-depth lookup (current tip + the tx's own block)
// is where a transient Base RPC consistency race was observed in production
// — the transaction receipt was already indexed, but the block that
// contains it briefly wasn't resolvable ("Block at number ... could not be
// found") on whichever RPC replica served that specific call. Bounded retry
// only around this lookup: a few short attempts, never an unbounded wait.
const BLOCK_LOOKUP_ATTEMPTS = 4
const BLOCK_LOOKUP_BASE_DELAY_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withBoundedRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < BLOCK_LOOKUP_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < BLOCK_LOOKUP_ATTEMPTS - 1) await sleep(BLOCK_LOOKUP_BASE_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError
}

// Not cached: createPublicClient() only builds a lightweight config object
// (no connection is dialled here), so there is no real cost to constructing
// it per call — and doing so sidesteps a gnarly TS inference mismatch
// between `base`'s OP-stack-specific client type and a module-level
// `ReturnType<typeof createPublicClient> | null` variable.
export function getClient(network = BASE_CAIP2) {
  const config = getSettlementNetwork(network)
  if (!config) throw new UnsupportedSettlementScopeError(network, '')
  const rpcUrl = getConfiguredRpcUrl(config)
  if (!rpcUrl) throw new Error(`${config.rpcEnvVar} is required for settlement observation on ${network}`)
  return createPublicClient({
    chain: config.chain,
    transport: http(rpcUrl),
  })
}

export interface ObservedTransfer {
  assetContract: string
  from: string
  to: string
  amountAtomic: bigint
  /**
   * D2.4 (Section 8): the exact selected event's own identity -- network is
   * supplied separately by the caller, so block_hash + transaction_hash +
   * log_index together uniquely identify THIS transfer log, never an
   * ambiguous "largest transfer in the tx" guess. A reorg/re-inclusion
   * produces a genuinely different blockHash for what is otherwise the same
   * intended payment -- see commerceObservation.ts's append-only handling.
   */
  blockHash: string
  /** EVM transaction hash or Solana transaction signature. */
  transactionHash: string
  /** Existing normalized event ordinal. Solana retains actual instruction identity below. */
  logIndex: number
  sourceAccount?: string | null
  destinationAccount?: string | null
  instructionIndex?: number | null
  innerInstructionIndex?: number | null
}

export type ChainInspectionState = 'not-found' | 'reverted' | 'success' | 'rpc-unavailable'

export interface SettlementObservation {
  state: ChainInspectionState
  blockNumber: bigint | null
  /** ISO timestamp of the block, when observed — independently fetched, not caller-supplied. */
  blockTimestamp: string | null
  /** Current tip minus tx block, +1. Null if not yet observed/available. */
  confirmations: number | null
  /** True only when state === 'success' AND confirmations >= the configured minimum. */
  sufficientlyConfirmed: boolean
  /** Every Transfer log emitted by the expected asset contract in this transaction. Empty if none, or if not yet confirmed/found. */
  transfers: ObservedTransfer[]
  /** Set only when the RPC call itself failed (distinct from a genuine "transaction not found"). */
  rpcError: string | null
  /**
   * D2.4 (Section 6): the ERC-3009 authorizer + nonce decoded directly from
   * the transaction's own calldata, independent of any caller claim. Null
   * whenever the transaction's input data isn't a recognized
   * transferWithAuthorization call (a different payment scheme, a wrapping
   * contract, or simply not yet available because state !== 'success') --
   * never fabricated, never inferred from the Transfer log alone.
   */
  paymentAuthorization: DecodedPaymentAuthorization | null
  /** Present for non-EVM observers that establish their own finality evidence. */
  finality?: FinalityEvaluation | null
}

const NOT_FOUND: SettlementObservation = {
  state: 'not-found',
  blockNumber: null,
  blockTimestamp: null,
  confirmations: null,
  sufficientlyConfirmed: false,
  transfers: [],
  rpcError: null,
  paymentAuthorization: null,
  finality: null,
}

/**
 * The subset of viem's PublicClient this module actually calls. Narrowed
 * deliberately so tests can inject a minimal fake client (simulating the
 * observed transient "Block at number ... could not be found" race) without
 * building a real viem client or hitting a real RPC endpoint. The real
 * `getClient()` return value satisfies this structurally.
 */
export interface MinimalSettlementClient {
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{
    status: 'success' | 'reverted'
    blockNumber: bigint
    blockHash: `0x${string}`
    logs: Log[]
  }>
  getBlockNumber: () => Promise<bigint>
  getBlock: (args: { blockHash: `0x${string}` }) => Promise<{ timestamp: bigint }>
  /** D2.4: fetches the transaction's own calldata for ERC-3009 authorization decoding. Optional so existing test fakes built before D2.4 still satisfy this interface structurally. */
  getTransaction?: (args: { hash: `0x${string}` }) => Promise<{ input: Hex }>
}

/**
 * Independently inspects a transaction on a configured EVM network. Never fabricates a
 * confirmed result: an RPC failure or a not-yet-mined transaction reports
 * `state: 'rpc-unavailable'` / `'not-found'`, never `'success'`.
 */
export async function observeTransaction(
  transactionHash: string,
  network: string,
  assetContract: string,
  deps: { client?: MinimalSettlementClient } = {}
): Promise<SettlementObservation> {
  if (network === SOLANA_CAIP2) {
    if (!getSolanaSupportedAsset(network, assetContract)) throw new UnsupportedSettlementScopeError(network, assetContract)
    return observeSolanaTransaction(transactionHash, network, assetContract)
  }
  const networkConfig = getSettlementNetwork(network)
  if (!networkConfig || !getSupportedAsset(network, assetContract)) {
    throw new UnsupportedSettlementScopeError(network, assetContract)
  }
  let publicClient: MinimalSettlementClient
  try {
    publicClient = deps.client ?? getClient(network)
  } catch (err: any) {
    return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: err?.message || 'RPC configuration unavailable' }
  }

  let receipt
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: transactionHash as `0x${string}` })
  } catch (err: any) {
    if (err?.name === 'TransactionReceiptNotFoundError') return NOT_FOUND
    return { ...NOT_FOUND, state: 'rpc-unavailable', rpcError: err?.message || 'RPC error fetching transaction receipt' }
  }

  // A revert is knowable directly from the already-fetched receipt --
  // no block/confirmation lookup required, so a transient block-metadata
  // race can never hide or delay a definitive revert.
  if (receipt.status !== 'success') {
    return {
      state: 'reverted',
      blockNumber: receipt.blockNumber,
      blockTimestamp: null,
      confirmations: null,
      sufficientlyConfirmed: false,
      transfers: [],
      rpcError: null,
      paymentAuthorization: null,
      finality: null,
    }
  }

  // Transfers are decoded straight from the receipt's own logs -- no
  // additional RPC call -- so this evidence survives even if the
  // block/confirmations lookup below fails. Each transfer carries its own
  // exact log_index (D2.4 Section 8): when a transaction emits multiple
  // Transfer logs of the expected asset, this is what lets a caller select
  // and record ONE deterministic event rather than an ambiguous "largest
  // transfer" guess (see commerceLifecycle.ts's selection logic).
  const decoded = parseEventLogs({ abi: TRANSFER_ABI, logs: receipt.logs, eventName: 'Transfer' })
  const transfers: ObservedTransfer[] = decoded
    .filter((log) => log.address.toLowerCase() === assetContract.toLowerCase())
    .map((log) => ({
      assetContract: getAddress(log.address),
      from: getAddress(log.args.from),
      to: getAddress(log.args.to),
      amountAtomic: log.args.value,
      blockHash: log.blockHash as string,
      transactionHash: log.transactionHash as string,
      logIndex: Number(log.logIndex),
    }))

  // D2.4 (Section 6): decoded independently from the transaction's own
  // calldata -- never from the caller's claim, never from the Transfer log
  // alone (a log only proves value moved, not who authorized it). Best
  // effort: absent on any transaction that isn't a direct
  // transferWithAuthorization call (a different scheme, or a relayer that
  // wraps it through another contract this module doesn't unwrap).
  let paymentAuthorization: DecodedPaymentAuthorization | null = null
  if (publicClient.getTransaction) {
    try {
      const tx = await publicClient.getTransaction({ hash: transactionHash as `0x${string}` })
      paymentAuthorization = decodeErc3009Authorization(tx.input)
    } catch {
      paymentAuthorization = null
    }
  }

  // Confirmation depth needs the current tip + the tx's own block. Prefer
  // the receipt's own blockHash over blockNumber: a hash lookup does not
  // depend on the answering replica's own notion of "current" block height,
  // which is exactly what was inconsistent in the observed incident.
  let currentBlock: bigint
  let blockTimestamp: string | null = null
  try {
    ;[currentBlock, blockTimestamp] = await withBoundedRetry(async () => {
      const [tip, block] = await Promise.all([
        publicClient.getBlockNumber(),
        publicClient.getBlock({ blockHash: receipt.blockHash }),
      ])
      return [tip, new Date(Number(block.timestamp) * 1000).toISOString()] as const
    })
  } catch (err: any) {
    // Already-observed receipt evidence (success + decoded transfers) is NOT
    // discarded here: report success with confirmations unknown rather than
    // fabricating a confirmation depth or throwing this evidence away.
    // Callers must treat confirmations === null / sufficientlyConfirmed ===
    // false as retryable, not as "no settlement happened" — see
    // finalizeRoute.ts's FinalizationPendingError gate.
    return {
      state: 'success',
      blockNumber: receipt.blockNumber,
      blockTimestamp: null,
      confirmations: null,
      sufficientlyConfirmed: false,
      transfers,
      rpcError: err?.message || 'RPC error fetching current block number/timestamp',
      paymentAuthorization,
      finality: null,
    }
  }
  const confirmations = Number(currentBlock - receipt.blockNumber) + 1

  let sufficientlyConfirmed: boolean
  let finalityRpcError: string | null = null
  if (networkConfig.finalityBlockTag === 'finalized') {
    try {
      const finalized = await withBoundedRetry(async () => {
        const head = await (publicClient as unknown as { getBlock: (args: { blockTag: 'finalized' }) => Promise<{ number: bigint }> }).getBlock({ blockTag: 'finalized' })
        if (typeof head.number !== 'bigint') throw new Error('RPC finalized block response had no block number')
        return head
      })
      sufficientlyConfirmed = receipt.blockNumber <= finalized.number
    } catch (err: any) {
      // Ethereum must never fall back to a confirmation count while its
      // policy is finalized-head. Keep independently-read receipt/log facts,
      // but make legacy settlement finalization wait/retry instead.
      sufficientlyConfirmed = false
      finalityRpcError = err?.message || 'RPC error fetching Ethereum finalized head'
    }
  } else {
    sufficientlyConfirmed = confirmations >= (getNetworkMinConfirmations(networkConfig) ?? 1)
  }

  return {
    state: 'success',
    blockNumber: receipt.blockNumber,
    blockTimestamp,
    confirmations,
    sufficientlyConfirmed,
    transfers,
    rpcError: finalityRpcError,
    paymentAuthorization,
    finality: null,
  }
}
