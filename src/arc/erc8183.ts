import type { Address } from 'viem'
import { arcProfile } from './config.js'
import type { ArcReadClient } from './erc8004.js'
export type ArcJobStatus = 'Open' | 'Funded' | 'Submitted' | 'Completed' | 'Rejected' | 'Expired' | 'Unknown'
export const ERC8183_STATUS: Record<number, ArcJobStatus> = { 0: 'Open', 1: 'Funded', 2: 'Submitted', 3: 'Completed', 4: 'Rejected', 5: 'Expired' }
/** The Arc Testnet reference implementation's documented read-only job shape. */
export const ERC8183_ABI = [{ type: 'function', name: 'getJob', stateMutability: 'view', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [{ type: 'tuple', components: [{ name: 'id', type: 'uint256' }, { name: 'client', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'evaluator', type: 'address' }, { name: 'description', type: 'string' }, { name: 'budget', type: 'uint256' }, { name: 'expiredAt', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'hook', type: 'address' }] }] }] as const
export interface ArcErc8183JobEvidence { kind: 'erc8183.job'; network: string; chainId: number; contract: Address; id: string; client: Address; provider: Address; evaluator: Address; description: string; budget: string; expiredAt: string; status: ArcJobStatus; hook: Address }
export async function observeErc8183Job(client: ArcReadClient, jobId: bigint, env: Record<string, string | undefined> = process.env): Promise<ArcErc8183JobEvidence> {
  const profile = arcProfile(env)
  const raw = await client.readContract({ address: profile.agenticCommerce, abi: ERC8183_ABI, functionName: 'getJob', args: [jobId] }) as { id: bigint; client: Address; provider: Address; evaluator: Address; description: string; budget: bigint; expiredAt: bigint; status: number; hook: Address }
  return modelJob({ ...raw, network: profile.caip2, chainId: profile.chainId, contract: profile.agenticCommerce as Address })
}
export const modelJob = (job: { status: number } & Record<string, unknown>): ArcErc8183JobEvidence => ({ kind: 'erc8183.job', network: String(job.network ?? 'unknown'), chainId: Number(job.chainId ?? 0), contract: String(job.contract ?? '0x0000000000000000000000000000000000000000') as Address, id: String(job.id ?? 'unknown'), client: String(job.client ?? '0x0000000000000000000000000000000000000000') as Address, provider: String(job.provider ?? '0x0000000000000000000000000000000000000000') as Address, evaluator: String(job.evaluator ?? '0x0000000000000000000000000000000000000000') as Address, description: String(job.description ?? ''), budget: String(job.budget ?? '0'), expiredAt: String(job.expiredAt ?? '0'), status: ERC8183_STATUS[Number(job.status)] ?? 'Unknown', hook: String(job.hook ?? '0x0000000000000000000000000000000000000000') as Address })
export const jobLimitation = 'An ERC-8183 Completed state is the reference contract lifecycle result; it is not independent proof of real-world service delivery.'
