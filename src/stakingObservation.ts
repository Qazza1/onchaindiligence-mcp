/** Independent Ethereum Mainnet observation of one Lido stETH Submitted event. */
import { getAddress, parseAbi, parseEventLogs, type Hex, type Log } from 'viem'
import { evaluateEthereumFinality, type FinalityEvaluation } from './finality.js'
import { ETHEREUM_CAIP2 } from './settlementNetworks.js'
import { getClient, isValidTransactionHash } from './settlement.js'
import { LIDO_STETH_PROXY } from './staking.js'

const ABI = parseAbi([
  'event Submitted(address indexed sender, uint256 amount, address referral)',
  'event TransferShares(address indexed from, address indexed to, uint256 sharesValue)',
])
const ZERO = '0x0000000000000000000000000000000000000000'

export type StakingObservationState = 'not-found' | 'reverted' | 'success' | 'unsupported-shape' | 'inconsistent-observation' | 'rpc-unavailable'
export interface StakingObservation {
  state: StakingObservationState
  network: typeof ETHEREUM_CAIP2
  transaction_hash: string
  block_number: string | null
  block_hash: string | null
  log_index: number | null
  contract: typeof LIDO_STETH_PROXY
  transaction_from: string | null
  transaction_to: string | null
  transaction_value_wei: string | null
  submitted_sender: string | null
  submitted_amount_wei: string | null
  referral: string | null
  shares_minted: string | null
  finality: FinalityEvaluation | null
  rpc_error: string | null
}
export interface MinimalStakingClient {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: Log[] }>
  getTransaction: (args: { hash: Hex }) => Promise<{ from: Hex; to: Hex | null; value: bigint }>
  getBlock: (args: { blockTag: 'finalized' }) => Promise<{ number: bigint; hash: Hex }>
}

const absent = (transaction_hash: string, state: StakingObservationState, rpc_error: string | null = null): StakingObservation => ({
  state, network: ETHEREUM_CAIP2, transaction_hash, block_number: null, block_hash: null, log_index: null, contract: LIDO_STETH_PROXY,
  transaction_from: null, transaction_to: null, transaction_value_wei: null, submitted_sender: null, submitted_amount_wei: null, referral: null, shares_minted: null, finality: null, rpc_error,
})

export async function observeLidoStaking(transactionHash: string, deps: { client?: MinimalStakingClient } = {}): Promise<StakingObservation> {
  if (!isValidTransactionHash(transactionHash)) throw new Error('transaction_hash must be a 0x-prefixed 32-byte transaction hash')
  let client: MinimalStakingClient
  try { client = deps.client ?? (getClient(ETHEREUM_CAIP2) as unknown as MinimalStakingClient) }
  catch (error: any) { return absent(transactionHash, 'rpc-unavailable', error?.message || 'Ethereum RPC unavailable') }
  let receipt: Awaited<ReturnType<MinimalStakingClient['getTransactionReceipt']>>
  let tx: Awaited<ReturnType<MinimalStakingClient['getTransaction']>>
  try { [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: transactionHash as Hex }), client.getTransaction({ hash: transactionHash as Hex })]) }
  catch (error: any) { return absent(transactionHash, error?.name === 'TransactionReceiptNotFoundError' ? 'not-found' : 'rpc-unavailable', error?.message || 'RPC lookup failed') }
  const common = { block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, transaction_from: getAddress(tx.from), transaction_to: tx.to ? getAddress(tx.to) : null, transaction_value_wei: tx.value.toString() }
  if (receipt.status !== 'success') return { ...absent(transactionHash, 'reverted'), ...common }
  if (!tx.to || tx.to.toLowerCase() !== LIDO_STETH_PROXY) return { ...absent(transactionHash, 'unsupported-shape'), ...common }
  const submitted = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: 'Submitted' })
    .filter((log) => log.address.toLowerCase() === LIDO_STETH_PROXY)
  if (submitted.length !== 1) return { ...absent(transactionHash, 'unsupported-shape'), ...common }
  const event = submitted[0]
  const submitted_sender = getAddress(event.args.sender)
  const submitted_amount_wei = event.args.amount.toString()
  const referral = getAddress(event.args.referral)
  const shares = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: 'TransferShares' })
    .filter((log) => log.address.toLowerCase() === LIDO_STETH_PROXY)
    .filter((log) => getAddress(log.args.from).toLowerCase() === ZERO && getAddress(log.args.to).toLowerCase() === submitted_sender.toLowerCase())
  const finality = await evaluateEthereumFinality(client as unknown as Parameters<typeof evaluateEthereumFinality>[0], receipt.blockNumber, receipt.blockHash)
  const inconsistent = submitted_sender.toLowerCase() !== common.transaction_from.toLowerCase() || submitted_amount_wei !== common.transaction_value_wei
  return {
    state: inconsistent ? 'inconsistent-observation' : 'success', network: ETHEREUM_CAIP2, transaction_hash: transactionHash,
    ...common, log_index: Number(event.logIndex), contract: LIDO_STETH_PROXY, submitted_sender, submitted_amount_wei, referral,
    shares_minted: shares.length === 1 ? shares[0].args.sharesValue.toString() : null, finality, rpc_error: null,
  }
}
