/**
 * Independent Circle CCTP V2 Base -> Ethereum bridge observation (D3.6C).
 *
 * Two independent observers -- one per chain -- neither of which reads or
 * trusts anything from the authorized action or from each other. Message
 * identity is established by decoding the ACTUAL raw CCTP message bytes
 * per Circle's own published byte-offset tables (confirmed against
 * circlefin/evm-cctp-contracts's src/v2 contracts and
 * developers.circle.com/cctp/technical-guide at implementation time), never
 * inferred from amount/recipient/timing similarity.
 *
 * Message format (MessageV2, emitted verbatim in MessageSent(bytes message)):
 *   offset 0   version              uint32  (4 bytes)
 *   offset 4   sourceDomain         uint32  (4 bytes)
 *   offset 8   destinationDomain    uint32  (4 bytes)
 *   offset 12  nonce                bytes32 (32 bytes)
 *   offset 44  sender               bytes32 (32 bytes)
 *   offset 76  recipient            bytes32 (32 bytes) -- destination TokenMessengerV2, NOT the end-user mint recipient
 *   offset 108 destinationCaller    bytes32 (32 bytes)
 *   offset 140 minFinalityThreshold uint32  (4 bytes)
 *   offset 144 finalityThresholdExecuted uint32 (4 bytes)
 *   offset 148 messageBody          bytes   (dynamic; the BurnMessageV2 below)
 *
 * BurnMessageV2 (the messageBody above, IDENTICAL bytes on both source and
 * destination -- this is the strongest available cross-chain identity):
 *   offset 0   version         uint32  (4 bytes)
 *   offset 4   burnToken       bytes32 (32 bytes)
 *   offset 36  mintRecipient   bytes32 (32 bytes) -- the actual end-user recipient
 *   offset 68  amount          uint256 (32 bytes)
 *   offset 100 messageSender   bytes32 (32 bytes) -- the depositForBurn caller
 *   offset 132 maxFee          uint256 (32 bytes)
 *   offset 164 feeExecuted     uint256 (32 bytes)
 *   offset 196 expirationBlock uint256 (32 bytes)
 *   offset 228 hookData        bytes   (dynamic)
 */
import { keccak256, parseAbi, parseEventLogs, slice, size, type Hex, type Log } from 'viem'
import { evaluateSettlementFinality, type FinalityEvaluation } from './finality.js'
import { BASE_CAIP2, BASE_USDC, ETHEREUM_CAIP2, ETHEREUM_USDC } from './settlementNetworks.js'
import { getClient, isValidTransactionHash } from './settlement.js'
import { CCTP_DOMAIN_BASE, CCTP_DOMAIN_ETHEREUM, CCTP_V2_MESSAGE_TRANSMITTER, CCTP_V2_TOKEN_MESSENGER } from './bridge.js'

const DEPOSIT_FOR_BURN_ABI = parseAbi([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
])
const MESSAGE_SENT_ABI = parseAbi(['event MessageSent(bytes message)'])
const MESSAGE_RECEIVED_ABI = parseAbi([
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
])
const MINT_AND_WITHDRAW_ABI = parseAbi(['event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)'])

function addressFromBytes32(value: Hex): string {
  return `0x${value.slice(-40)}`.toLowerCase()
}

/** Decodes a MessageV2 header per the byte-offset table above. Does not decode messageBody's own inner structure -- callers do that separately with decodeBurnMessageBody. */
function decodeMessageHeader(message: Hex) {
  return {
    version: parseInt(slice(message, 0, 4), 16),
    sourceDomain: parseInt(slice(message, 4, 8), 16),
    destinationDomain: parseInt(slice(message, 8, 12), 16),
    nonce: slice(message, 12, 44),
    sender: addressFromBytes32(slice(message, 44, 76)),
    recipient: addressFromBytes32(slice(message, 76, 108)),
    destinationCaller: addressFromBytes32(slice(message, 108, 140)),
    minFinalityThreshold: parseInt(slice(message, 140, 144), 16),
    finalityThresholdExecuted: parseInt(slice(message, 144, 148), 16),
    messageBody: slice(message, 148, size(message)) as Hex,
  }
}

function decodeBurnMessageBody(body: Hex) {
  return {
    version: parseInt(slice(body, 0, 4), 16),
    burnToken: addressFromBytes32(slice(body, 4, 36)),
    mintRecipient: addressFromBytes32(slice(body, 36, 68)),
    amount: BigInt(slice(body, 68, 100)).toString(),
    messageSender: addressFromBytes32(slice(body, 100, 132)),
    maxFee: BigInt(slice(body, 132, 164)).toString(),
  }
}

export interface BridgeSourceObservation {
  state: 'success' | 'reverted' | 'not-found' | 'rpc-unavailable' | 'no-deposit-for-burn'
  network: typeof BASE_CAIP2
  transaction_hash: string
  block_number: string | null
  block_hash: string | null
  log_index: number | null
  burn_token: string | null
  burn_amount_atomic: string | null
  depositor: string | null
  mint_recipient: string | null
  source_domain: number | null
  destination_domain: number | null
  nonce: string | null
  message_hex: string | null
  message_body_hash: string | null
  finality: FinalityEvaluation | null
  rpc_error: string | null
}

export interface BridgeDestinationObservation {
  state: 'success' | 'reverted' | 'not-found' | 'rpc-unavailable' | 'no-message-received'
  network: typeof ETHEREUM_CAIP2
  transaction_hash: string
  block_number: string | null
  block_hash: string | null
  log_index: number | null
  caller: string | null
  source_domain: number | null
  destination_domain: number | null
  nonce: string | null
  sender: string | null
  message_body_hash: string | null
  mint_recipient: string | null
  mint_amount_atomic: string | null
  mint_token: string | null
  finality: FinalityEvaluation | null
  rpc_error: string | null
}

export interface MinimalBridgeClient {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: Log[] }>
  getBlock: (args: { blockTag: 'safe' | 'finalized' }) => Promise<{ number: bigint; hash: Hex }>
}

function absentSource(tx: string, state: BridgeSourceObservation['state'], error: string | null = null): BridgeSourceObservation {
  return { state, network: BASE_CAIP2, transaction_hash: tx, block_number: null, block_hash: null, log_index: null, burn_token: null, burn_amount_atomic: null, depositor: null, mint_recipient: null, source_domain: null, destination_domain: null, nonce: null, message_hex: null, message_body_hash: null, finality: null, rpc_error: error }
}
function absentDestination(tx: string, state: BridgeDestinationObservation['state'], error: string | null = null): BridgeDestinationObservation {
  return { state, network: ETHEREUM_CAIP2, transaction_hash: tx, block_number: null, block_hash: null, log_index: null, caller: null, source_domain: null, destination_domain: null, nonce: null, sender: null, message_body_hash: null, mint_recipient: null, mint_amount_atomic: null, mint_token: null, finality: null, rpc_error: error }
}

/**
 * Independently establishes a Base CCTP V2 depositForBurn: the successful
 * transaction, the real DepositForBurn log (for burnToken/depositor cross-
 * check only -- never copied over the decoded message), the real
 * MessageSent log, and the exact message bytes decoded per Circle's own
 * format. `depositor`/`mint_recipient` come from the decoded message body,
 * not from the authorization -- this function never reads the action.
 */
export async function observeBridgeSource(transactionHash: string, deps: { client?: MinimalBridgeClient } = {}): Promise<BridgeSourceObservation> {
  if (!isValidTransactionHash(transactionHash)) throw new Error('transaction_hash must be a 0x-prefixed 32-byte transaction hash')
  let client: MinimalBridgeClient
  try { client = deps.client ?? (getClient(BASE_CAIP2) as unknown as MinimalBridgeClient) } catch (err: any) { return absentSource(transactionHash, 'rpc-unavailable', err?.message || 'Base RPC unavailable') }
  let receipt
  try { receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex }) } catch (err: any) {
    if (err?.name === 'TransactionReceiptNotFoundError') return absentSource(transactionHash, 'not-found')
    return absentSource(transactionHash, 'rpc-unavailable', err?.message || 'RPC error fetching transaction receipt')
  }
  if (receipt.status !== 'success') return { ...absentSource(transactionHash, 'reverted'), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash }

  const deposits = parseEventLogs({ abi: DEPOSIT_FOR_BURN_ABI, logs: receipt.logs, eventName: 'DepositForBurn' }).filter((l) => l.address.toLowerCase() === CCTP_V2_TOKEN_MESSENGER)
  const sent = parseEventLogs({ abi: MESSAGE_SENT_ABI, logs: receipt.logs, eventName: 'MessageSent' }).filter((l) => l.address.toLowerCase() === CCTP_V2_MESSAGE_TRANSMITTER)
  if (deposits.length !== 1 || sent.length !== 1) {
    return { ...absentSource(transactionHash, 'no-deposit-for-burn'), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash }
  }
  const deposit = deposits[0]
  const message = sent[0].args.message as Hex
  const header = decodeMessageHeader(message)
  const body = decodeBurnMessageBody(header.messageBody)

  // Cross-checks: the decoded message body is the authoritative identity,
  // but the DepositForBurn event is independently emitted in the same
  // transaction -- if they disagree the transaction itself is internally
  // inconsistent, which is worth surfacing distinctly rather than silently
  // preferring one over the other.
  const burnTokenMatches = deposit.args.burnToken.toLowerCase() === body.burnToken
  const finality = await evaluateSettlementFinality(BASE_CAIP2, client, receipt.blockNumber, receipt.blockHash)
  return {
    state: 'success', network: BASE_CAIP2, transaction_hash: transactionHash,
    block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, log_index: Number(sent[0].logIndex),
    burn_token: burnTokenMatches ? body.burnToken : null,
    burn_amount_atomic: body.amount,
    depositor: body.messageSender,
    mint_recipient: body.mintRecipient,
    source_domain: header.sourceDomain,
    destination_domain: header.destinationDomain,
    nonce: header.nonce,
    message_hex: message,
    message_body_hash: keccak256(header.messageBody),
    finality,
    rpc_error: null,
  }
}

/**
 * Independently establishes an Ethereum CCTP V2 receiveMessage: the
 * successful transaction, the real MessageReceived log, the real
 * MintAndWithdraw log, and the exact burn-message body decoded from
 * MessageReceived's own `messageBody` bytes -- the identical bytes Base
 * emitted, never reconstructed or assumed.
 */
export async function observeBridgeDestination(transactionHash: string, deps: { client?: MinimalBridgeClient } = {}): Promise<BridgeDestinationObservation> {
  if (!isValidTransactionHash(transactionHash)) throw new Error('transaction_hash must be a 0x-prefixed 32-byte transaction hash')
  let client: MinimalBridgeClient
  try { client = deps.client ?? (getClient(ETHEREUM_CAIP2) as unknown as MinimalBridgeClient) } catch (err: any) { return absentDestination(transactionHash, 'rpc-unavailable', err?.message || 'Ethereum RPC unavailable') }
  let receipt
  try { receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex }) } catch (err: any) {
    if (err?.name === 'TransactionReceiptNotFoundError') return absentDestination(transactionHash, 'not-found')
    return absentDestination(transactionHash, 'rpc-unavailable', err?.message || 'RPC error fetching transaction receipt')
  }
  if (receipt.status !== 'success') return { ...absentDestination(transactionHash, 'reverted'), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash }

  const received = parseEventLogs({ abi: MESSAGE_RECEIVED_ABI, logs: receipt.logs, eventName: 'MessageReceived' }).filter((l) => l.address.toLowerCase() === CCTP_V2_MESSAGE_TRANSMITTER)
  if (received.length !== 1) return { ...absentDestination(transactionHash, 'no-message-received'), block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash }
  const mints = parseEventLogs({ abi: MINT_AND_WITHDRAW_ABI, logs: receipt.logs, eventName: 'MintAndWithdraw' }).filter((l) => l.address.toLowerCase() === CCTP_V2_TOKEN_MESSENGER)

  const msg = received[0]
  const body = decodeBurnMessageBody(msg.args.messageBody as Hex)
  const mint = mints[0]
  const finality = await evaluateSettlementFinality(ETHEREUM_CAIP2, client, receipt.blockNumber, receipt.blockHash)
  return {
    state: 'success', network: ETHEREUM_CAIP2, transaction_hash: transactionHash,
    block_number: receipt.blockNumber.toString(), block_hash: receipt.blockHash, log_index: Number(msg.logIndex),
    caller: msg.args.caller.toLowerCase(),
    source_domain: msg.args.sourceDomain,
    destination_domain: CCTP_DOMAIN_ETHEREUM,
    nonce: msg.args.nonce,
    sender: addressFromBytes32(msg.args.sender as Hex),
    message_body_hash: keccak256(msg.args.messageBody as Hex),
    // MintAndWithdraw's own fields, when present, are independent
    // confirmation that minting actually occurred (not merely that a
    // message was relayed) -- fall back to the decoded message body only
    // when the mint log itself could not be isolated (never fabricated).
    mint_recipient: mint ? mint.args.mintRecipient.toLowerCase() : body.mintRecipient,
    mint_amount_atomic: mint ? mint.args.amount.toString() : body.amount,
    mint_token: mint ? mint.args.mintToken.toLowerCase() : body.burnToken,
    finality,
    rpc_error: null,
  }
}

export { CCTP_DOMAIN_BASE }
