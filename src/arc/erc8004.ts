import { decodeEventLog, type Address, type Hex } from 'viem'
import { arcProfile } from './config.js'

/** Read-only ABI surface documented by Arc for its ERC-8004 deployment. */
export const ERC8004_IDENTITY_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const
export const ERC8004_VALIDATION_ABI = [{ type: 'function', name: 'getValidationStatus', stateMutability: 'view', inputs: [{ name: 'requestHash', type: 'bytes32' }], outputs: [{ name: 'validatorAddress', type: 'address' }, { name: 'agentId', type: 'uint256' }, { name: 'response', type: 'uint8' }, { name: 'responseHash', type: 'bytes32' }, { name: 'tag', type: 'string' }, { name: 'lastUpdate', type: 'uint256' }] }] as const
export const ERC8004_REPUTATION_ABI = [
  { type: 'function', name: 'getClients', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'readAllFeedback', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'clientAddresses', type: 'address[]' }, { name: 'tag1', type: 'string' }, { name: 'tag2', type: 'string' }, { name: 'includeRevoked', type: 'bool' }], outputs: [{ name: 'clients', type: 'address[]' }, { name: 'feedbackIndexes', type: 'uint64[]' }, { name: 'values', type: 'int128[]' }, { name: 'valueDecimals', type: 'uint8[]' }, { name: 'tag1s', type: 'string[]' }, { name: 'tag2s', type: 'string[]' }, { name: 'revokedStatuses', type: 'bool[]' }] },
] as const
export const ERC8004_IDENTITY_EVENTS = [{ type: 'event', name: 'Transfer', anonymous: false, inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] }] as const
export const ERC8004_VALIDATION_EVENTS = [
  { type: 'event', name: 'ValidationRequest', anonymous: false, inputs: [{ name: 'validatorAddress', type: 'address', indexed: true }, { name: 'agentId', type: 'uint256', indexed: true }, { name: 'requestURI', type: 'string', indexed: false }, { name: 'requestHash', type: 'bytes32', indexed: true }] },
  { type: 'event', name: 'ValidationResponse', anonymous: false, inputs: [{ name: 'validatorAddress', type: 'address', indexed: true }, { name: 'agentId', type: 'uint256', indexed: true }, { name: 'requestHash', type: 'bytes32', indexed: true }, { name: 'response', type: 'uint8', indexed: false }, { name: 'responseURI', type: 'string', indexed: false }, { name: 'responseHash', type: 'bytes32', indexed: false }, { name: 'tag', type: 'string', indexed: false }] },
] as const

export interface ArcReadClient { readContract(parameters: any): Promise<any> }
export interface ArcErc8004IdentityEvidence { kind: 'erc8004.identity'; network: string; chainId: number; registry: Address; agentId: string; owner: Address; metadataUri: string }
export interface ArcErc8004ValidationEvidence { kind: 'erc8004.validation'; network: string; chainId: number; registry: Address; requestHash: Hex; validator: Address; agentId: string; response: number; responseHash: Hex; tag: string; lastUpdate: string }
export interface ArcErc8004FeedbackEvidence { client: Address; feedbackIndex: string; value: string; valueDecimals: number; tag1: string; tag2: string; isRevoked: boolean }
export interface ArcErc8004ReputationEvidence { kind: 'erc8004.reputation'; network: string; chainId: number; registry: Address; agentId: string; clients: Address[]; feedback: ArcErc8004FeedbackEvidence[]; provenance: 'erc8004-reputation-registry'; interpretation: string }
export interface ArcLogInput { address: Address; data: Hex; topics: readonly Hex[]; transactionHash?: Hex | null; blockNumber?: bigint | null; blockHash?: Hex | null; logIndex?: number | null }
export interface ArcReceiptInput { logs: readonly ArcLogInput[] }
interface EventProvenance { network: string; chainId: number; contract: Address; transactionHash?: Hex; blockNumber?: string; blockHash?: Hex; logIndex?: number }
export type ArcErc8004EventEvidence =
  | ({ kind: 'erc8004.identity-mint'; eventName: 'Transfer'; agentId: string; from: Address; owner: Address } & EventProvenance)
  | ({ kind: 'erc8004.validation-request'; eventName: 'ValidationRequest'; validator: Address; agentId: string; requestUri: string; requestHash: Hex } & EventProvenance)
  | ({ kind: 'erc8004.validation-response'; eventName: 'ValidationResponse'; validator: Address; agentId: string; requestHash: Hex; response: number; responseUri: string; responseHash: Hex; tag: string; interpretation: string } & EventProvenance)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function eventProvenance(log: ArcLogInput, contract: Address, network: string, chainId: number): EventProvenance {
  return {
    network,
    chainId,
    contract,
    ...(log.transactionHash ? { transactionHash: log.transactionHash } : {}),
    ...(log.blockNumber !== undefined && log.blockNumber !== null ? { blockNumber: log.blockNumber.toString() } : {}),
    ...(log.blockHash ? { blockHash: log.blockHash } : {}),
    ...(log.logIndex !== undefined && log.logIndex !== null ? { logIndex: log.logIndex } : {}),
  }
}

export async function observeErc8004Identity(client: ArcReadClient, agentId: bigint, env: Record<string, string | undefined> = process.env): Promise<ArcErc8004IdentityEvidence> {
  const profile = arcProfile(env)
  const [owner, metadataUri] = await Promise.all([client.readContract({ address: profile.identityRegistry as Address, abi: ERC8004_IDENTITY_ABI, functionName: 'ownerOf', args: [agentId] }) as Promise<Address>, client.readContract({ address: profile.identityRegistry as Address, abi: ERC8004_IDENTITY_ABI, functionName: 'tokenURI', args: [agentId] }) as Promise<string>])
  return { kind: 'erc8004.identity', network: profile.caip2, chainId: profile.chainId, registry: profile.identityRegistry as Address, agentId: agentId.toString(), owner, metadataUri }
}
export async function observeErc8004Validation(client: ArcReadClient, requestHash: Hex, env: Record<string, string | undefined> = process.env): Promise<ArcErc8004ValidationEvidence> {
  const profile = arcProfile(env)
  const raw = await client.readContract({ address: profile.validationRegistry as Address, abi: ERC8004_VALIDATION_ABI, functionName: 'getValidationStatus', args: [requestHash] }) as readonly [Address, bigint, number, Hex, string, bigint]
  return { kind: 'erc8004.validation', network: profile.caip2, chainId: profile.chainId, registry: profile.validationRegistry as Address, requestHash, validator: raw[0], agentId: raw[1].toString(), response: Number(raw[2]), responseHash: raw[3], tag: raw[4], lastUpdate: raw[5].toString() }
}
export async function observeErc8004Reputation(client: ArcReadClient, agentId: bigint, env: Record<string, string | undefined> = process.env): Promise<ArcErc8004ReputationEvidence> {
  const profile = arcProfile(env)
  const registry = profile.reputationRegistry as Address
  const clients = await client.readContract({ address: registry, abi: ERC8004_REPUTATION_ABI, functionName: 'getClients', args: [agentId] }) as Address[]
  let feedback: ArcErc8004FeedbackEvidence[] = []
  if (clients.length > 0) {
    const raw = await client.readContract({ address: registry, abi: ERC8004_REPUTATION_ABI, functionName: 'readAllFeedback', args: [agentId, clients, '', '', true] }) as readonly [Address[], bigint[], bigint[], number[], string[], string[], boolean[]]
    const lengths = raw.map((values) => values.length)
    if (!lengths.every((length) => length === lengths[0])) throw new Error('ERC-8004 reputation arrays have inconsistent lengths')
    feedback = raw[0].map((clientAddress, index) => ({ client: clientAddress, feedbackIndex: raw[1][index]!.toString(), value: raw[2][index]!.toString(), valueDecimals: Number(raw[3][index]), tag1: raw[4][index]!, tag2: raw[5][index]!, isRevoked: raw[6][index]! }))
  }
  return { kind: 'erc8004.reputation', network: profile.caip2, chainId: profile.chainId, registry, agentId: agentId.toString(), clients, feedback, provenance: 'erc8004-reputation-registry', interpretation: clients.length === 0 ? 'No client/reviewer addresses or feedback are present in the registry.' : 'Raw registry feedback only; no OCD score, confidence, validity, safety, or compliance conclusion is inferred.' }
}

export function decodeErc8004IdentityMint(log: ArcLogInput, env: Record<string, string | undefined> = process.env): ArcErc8004EventEvidence | undefined {
  const profile = arcProfile(env)
  const registry = profile.identityRegistry as Address
  if (log.address.toLowerCase() !== registry.toLowerCase()) return undefined
  try {
    const decoded = decodeEventLog({ abi: ERC8004_IDENTITY_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    if (decoded.eventName !== 'Transfer' || decoded.args.from.toLowerCase() !== ZERO_ADDRESS) return undefined
    return { kind: 'erc8004.identity-mint', eventName: 'Transfer', agentId: decoded.args.tokenId.toString(), from: decoded.args.from, owner: decoded.args.to, ...eventProvenance(log, registry, profile.caip2, profile.chainId) }
  } catch { return undefined }
}

export function decodeErc8004ValidationEvent(log: ArcLogInput, env: Record<string, string | undefined> = process.env): ArcErc8004EventEvidence | undefined {
  const profile = arcProfile(env)
  const registry = profile.validationRegistry as Address
  if (log.address.toLowerCase() !== registry.toLowerCase()) return undefined
  try {
    const decoded = decodeEventLog({ abi: ERC8004_VALIDATION_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    const provenance = eventProvenance(log, registry, profile.caip2, profile.chainId)
    if (decoded.eventName === 'ValidationRequest') return { kind: 'erc8004.validation-request', eventName: decoded.eventName, validator: decoded.args.validatorAddress, agentId: decoded.args.agentId.toString(), requestUri: decoded.args.requestURI, requestHash: decoded.args.requestHash, ...provenance }
    if (decoded.eventName === 'ValidationResponse') return { kind: 'erc8004.validation-response', eventName: decoded.eventName, validator: decoded.args.validatorAddress, agentId: decoded.args.agentId.toString(), requestHash: decoded.args.requestHash, response: Number(decoded.args.response), responseUri: decoded.args.responseURI, responseHash: decoded.args.responseHash, tag: decoded.args.tag, interpretation: 'Validator registry assertion only; this event is not an OCD VALID or INVALID result.', ...provenance }
    return undefined
  } catch { return undefined }
}
export function decodeErc8004Receipt(receipt: ArcReceiptInput, env: Record<string, string | undefined> = process.env): ArcErc8004EventEvidence[] {
  return receipt.logs.flatMap((log) => {
    const evidence = decodeErc8004IdentityMint(log, env) ?? decodeErc8004ValidationEvent(log, env)
    return evidence ? [evidence] : []
  })
}
/** Registry responses are third-party assertions; they are never an OCD verification state. */
export const modelValidation = (v: ArcErc8004ValidationEvidence) => ({ ...v, provenance: 'erc8004-validation-registry' as const, interpretation: 'Registry response only; it is not OCD verification, independent proof of underlying behaviour, or an OCD VALID result.' })
