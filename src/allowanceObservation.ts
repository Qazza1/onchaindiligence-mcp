/** Independent Base USDC Approval-event observation (D3.6A). */
import { getAddress, parseAbi, parseEventLogs, type Hex, type Log } from 'viem'
import { evaluateBaseFinality, type FinalityEvaluation } from './finality.js'
import { BASE_CAIP2, BASE_USDC } from './settlementNetworks.js'
import { getClient, isValidTransactionHash } from './settlement.js'

const APPROVAL_ABI = parseAbi([
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

export interface ApprovalEvent {
  owner: string
  spender: string
  value_atomic: string
  transaction_hash: string
  block_hash: string
  log_index: number
}
export type AllowanceChainState = 'not-found' | 'reverted' | 'success' | 'rpc-unavailable'
export interface AllowanceObservation {
  state: AllowanceChainState
  network: typeof BASE_CAIP2
  token: typeof BASE_USDC
  transaction_hash: string
  block_number: string | null
  block_hash: string | null
  block_timestamp: string | null
  approvals: ApprovalEvent[]
  finality: FinalityEvaluation | null
  /** A historical eth_call at the approval block; never a later mutable head state. */
  post_state: { state: 'OBSERVED'; value_atomic: string; block_number: string } | { state: 'UNRESOLVED'; reason: string } | null
  rpc_error: string | null
}

export interface MinimalAllowanceClient {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: Log[] }>
  getBlock: (args: { blockHash: Hex } | { blockTag: 'safe' }) => Promise<{ timestamp?: bigint; number: bigint; hash: Hex }>
  readContract?: (args: { address: Hex; abi: typeof APPROVAL_ABI; functionName: 'allowance'; args: [Hex, Hex]; blockNumber?: bigint; blockTag?: 'latest' }) => Promise<bigint>
}

const absent = (tx: string, state: AllowanceChainState, error: string | null = null): AllowanceObservation => ({ state, network: BASE_CAIP2, token: BASE_USDC, transaction_hash: tx, block_number: null, block_hash: null, block_timestamp: null, approvals: [], finality: null, post_state: null, rpc_error: error })

export async function observeAllowanceApproval(
  transactionHash: string,
  deps: { client?: MinimalAllowanceClient } = {}
): Promise<AllowanceObservation> {
  if (!isValidTransactionHash(transactionHash)) throw new Error('transaction_hash must be a 0x-prefixed 32-byte transaction hash')
  let client: MinimalAllowanceClient
  try { client = deps.client ?? (getClient(BASE_CAIP2) as unknown as MinimalAllowanceClient) } catch (err: any) { return absent(transactionHash, 'rpc-unavailable', err?.message || 'Base RPC unavailable') }
  let receipt
  try { receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex }) } catch (err: any) {
    if (err?.name === 'TransactionReceiptNotFoundError') return absent(transactionHash, 'not-found')
    return absent(transactionHash, 'rpc-unavailable', err?.message || 'RPC error fetching transaction receipt')
  }
  if (receipt.status !== 'success') return { ...absent(transactionHash, 'reverted'), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash }
  const approvals = parseEventLogs({ abi: APPROVAL_ABI, logs: receipt.logs, eventName: 'Approval' })
    .filter((log) => log.address.toLowerCase() === BASE_USDC)
    .map((log) => ({ owner: getAddress(log.args.owner), spender: getAddress(log.args.spender), value_atomic: log.args.value.toString(), transaction_hash: log.transactionHash as string, block_hash: log.blockHash as string, log_index: Number(log.logIndex) }))
    .sort((a, b) => a.log_index - b.log_index)
  let timestamp: string | null = null
  try {
    const block = await client.getBlock({ blockHash: receipt.blockHash })
    if (typeof block.timestamp === 'bigint') timestamp = new Date(Number(block.timestamp) * 1000).toISOString()
  } catch { /* receipt evidence remains useful; timestamp is optional */ }
  const finality = await evaluateBaseFinality(client as unknown as Parameters<typeof evaluateBaseFinality>[0], receipt.blockNumber, receipt.blockHash)
  let post_state: AllowanceObservation['post_state'] = null
  if (approvals.length === 1 && client.readContract) {
    try {
      const observed = await client.readContract({ address: BASE_USDC as Hex, abi: APPROVAL_ABI, functionName: 'allowance', args: [approvals[0].owner as Hex, approvals[0].spender as Hex], blockNumber: receipt.blockNumber })
      post_state = { state: 'OBSERVED', value_atomic: observed.toString(), block_number: receipt.blockNumber.toString() }
    } catch (err: any) { post_state = { state: 'UNRESOLVED', reason: err?.message || 'historical allowance read unavailable' } }
  } else if (approvals.length === 1) post_state = { state: 'UNRESOLVED', reason: 'historical allowance read unavailable' }
  return { state: 'success', network: BASE_CAIP2, token: BASE_USDC, transaction_hash: transactionHash, block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, block_timestamp: timestamp, approvals, finality, post_state, rpc_error: null }
}

/** Optional pre-action state; never influences static policy evaluation. */
export async function observeCurrentAllowance(owner: string | null, spender: string, deps: { client?: MinimalAllowanceClient } = {}) {
  if (!owner) return { state: 'UNRESOLVED' as const, reason: 'owner is unknown; current allowance cannot be read' }
  try {
    const client = deps.client ?? (getClient(BASE_CAIP2) as unknown as MinimalAllowanceClient)
    if (!client.readContract) return { state: 'UNRESOLVED' as const, reason: 'allowance read is unavailable' }
    const value = await client.readContract({ address: BASE_USDC as Hex, abi: APPROVAL_ABI, functionName: 'allowance', args: [owner as Hex, spender as Hex], blockTag: 'latest' })
    return { state: 'OBSERVED' as const, value_atomic: value.toString(), observed_at: new Date().toISOString() }
  } catch (err: any) { return { state: 'UNRESOLVED' as const, reason: err?.message || 'allowance read unavailable' } }
}
