import type { Address, Hex } from 'viem'
import { arcProfile } from './config.js'

/** Read-only ABI surface documented by Arc for its ERC-8004 deployment. */
export const ERC8004_IDENTITY_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const
export const ERC8004_VALIDATION_ABI = [{ type: 'function', name: 'getValidationStatus', stateMutability: 'view', inputs: [{ name: 'requestHash', type: 'bytes32' }], outputs: [{ name: 'validatorAddress', type: 'address' }, { name: 'agentId', type: 'uint256' }, { name: 'response', type: 'uint8' }, { name: 'responseHash', type: 'bytes32' }, { name: 'tag', type: 'string' }, { name: 'lastUpdate', type: 'uint256' }] }] as const
export interface ArcReadClient { readContract(parameters: unknown): Promise<unknown> }
export interface ArcErc8004IdentityEvidence { kind: 'erc8004.identity'; network: string; chainId: number; registry: Address; agentId: string; owner: Address; metadataUri: string }
export interface ArcErc8004ValidationEvidence { kind: 'erc8004.validation'; network: string; chainId: number; registry: Address; requestHash: Hex; validator: Address; agentId: string; response: number; responseHash: Hex; tag: string; lastUpdate: string }
export async function observeErc8004Identity(client: ArcReadClient, agentId: bigint, env: Record<string, string | undefined> = process.env): Promise<ArcErc8004IdentityEvidence> {
  const profile = arcProfile(env)
  const [owner, metadataUri] = await Promise.all([client.readContract({ address: profile.identityRegistry, abi: ERC8004_IDENTITY_ABI, functionName: 'ownerOf', args: [agentId] }) as Promise<Address>, client.readContract({ address: profile.identityRegistry, abi: ERC8004_IDENTITY_ABI, functionName: 'tokenURI', args: [agentId] }) as Promise<string>])
  return { kind: 'erc8004.identity', network: profile.caip2, chainId: profile.chainId, registry: profile.identityRegistry as Address, agentId: agentId.toString(), owner, metadataUri }
}
export async function observeErc8004Validation(client: ArcReadClient, requestHash: Hex, env: Record<string, string | undefined> = process.env): Promise<ArcErc8004ValidationEvidence> {
  const profile = arcProfile(env)
  const raw = await client.readContract({ address: profile.validationRegistry, abi: ERC8004_VALIDATION_ABI, functionName: 'getValidationStatus', args: [requestHash] }) as readonly [Address, bigint, number, Hex, string, bigint]
  return { kind: 'erc8004.validation', network: profile.caip2, chainId: profile.chainId, registry: profile.validationRegistry as Address, requestHash, validator: raw[0], agentId: raw[1].toString(), response: Number(raw[2]), responseHash: raw[3], tag: raw[4], lastUpdate: raw[5].toString() }
}
/** Registry responses are third-party assertions; they are never an OCD verification state. */
export const modelValidation = (v: ArcErc8004ValidationEvidence) => ({ ...v, provenance: 'erc8004-validation-registry' as const, interpretation: 'Registry response only; it is not OCD verification, independent proof of underlying behaviour, or an OCD VALID result.' })
