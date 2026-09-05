/**
 * settlement.ts — independent on-chain settlement verification (D2.2).
 *
 * V1 CHAIN SCOPE, explicitly: Base mainnet (eip155:8453) ERC-20 transfers
 * only, with Base USDC as the only supported asset. This is a truthful,
 * narrow scope — not a fake multi-chain abstraction — but the shape here
 * (a per-network/per-asset registry + one inspection function) is meant to
 * extend cleanly when a second network/asset is actually added.
 *
 * OCD never trusts a caller's claim that a payment settled. This module
 * reads the transaction receipt and its logs directly from a Base JSON-RPC
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
import { base } from 'viem/chains'
import { decodeErc3009Authorization, type DecodedPaymentAuthorization } from './paymentAuthorization.js'

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export const BASE_CAIP2 = 'eip155:8453'

/** Per-network, per-asset (lowercase address) support registry. Extend here for future networks/assets. */
const SUPPORTED_SETTLEMENT_ASSETS: Record<string, Record<string, { decimals: number; symbol: string }>> = {
  [BASE_CAIP2]: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { decimals: 6, symbol: 'USDC' },
  },
}

export function getSupportedAsset(network: string, assetContract: string): { decimals: number; symbol: string } | null {
  return SUPPORTED_SETTLEMENT_ASSETS[network]?.[assetContract.toLowerCase()] ?? null
}

export class UnsupportedSettlementScopeError extends Error {
  constructor(network: string, assetContract: string) {
    super(
      `settlement verification does not support network "${network}" / asset "${assetContract}" in v1 — ` +
        `only Base mainnet (${BASE_CAIP2}) USDC is supported`
    )
    this.name = 'UnsupportedSettlementScopeError'
  }
}

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

export function isValidTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && TRANSACTION_HASH_PATTERN.test(value)
}

function minConfirmations(): number {
  const raw = process.env.BASE_MIN_CONFIRMATIONS
  const parsed = raw ? Number(raw) : NaN
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
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
export function getClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  })
}

export interface ObservedTransfer {
  assetContract: string
  from: string
  to: string
  amountAtomic: bigint
  /**
   * D2.4 (Section 8): the exact selected event's own identity -- network is
   * implicit (this module is Base-only), so block_hash + transaction_hash +
   * log_index together uniquely identify THIS transfer log, never an
   * ambiguous "largest transfer in the tx" guess. A reorg/re-inclusion
   * produces a genuinely different blockHash for what is otherwise the same
   * intended payment -- see commerceObservation.ts's append-only handling.
   */
  blockHash: string
  transactionHash: string
  logIndex: number
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
 * Independently inspects a transaction on Base mainnet. Never fabricates a
 * confirmed result: an RPC failure or a not-yet-mined transaction reports
 * `state: 'rpc-unavailable'` / `'not-found'`, never `'success'`.
 */
export async function observeTransaction(
  transactionHash: `0x${string}`,
  network: string,
  assetContract: string,
  deps: { client?: MinimalSettlementClient } = {}
): Promise<SettlementObservation> {
  if (!getSupportedAsset(network, assetContract)) {
    throw new UnsupportedSettlementScopeError(network, assetContract)
  }
  const publicClient = deps.client ?? getClient()

  let receipt
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: transactionHash })
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
      const tx = await publicClient.getTransaction({ hash: transactionHash })
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
    }
  }
  const confirmations = Number(currentBlock - receipt.blockNumber) + 1

  return {
    state: 'success',
    blockNumber: receipt.blockNumber,
    blockTimestamp,
    confirmations,
    sufficientlyConfirmed: confirmations >= minConfirmations(),
    transfers,
    rpcError: null,
    paymentAuthorization,
  }
}
