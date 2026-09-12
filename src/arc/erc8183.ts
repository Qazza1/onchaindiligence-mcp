import { decodeEventLog, type Address, type Hex } from 'viem'
import { arcProfile } from './config.js'
import type { ArcLogInput, ArcReadClient, ArcReceiptInput } from './erc8004.js'
export type ArcJobStatus = 'Open' | 'Funded' | 'Submitted' | 'Completed' | 'Rejected' | 'Expired' | 'Unknown'
export const ERC8183_STATUS: Record<number, ArcJobStatus> = { 0: 'Open', 1: 'Funded', 2: 'Submitted', 3: 'Completed', 4: 'Rejected', 5: 'Expired' }
export const jobLimitation = 'An ERC-8183 Completed state is the reference contract lifecycle result; it is not independent proof of real-world service delivery.'
/** The Arc Testnet reference implementation's documented read-only job shape. */
export const ERC8183_ABI = [{ type: 'function', name: 'getJob', stateMutability: 'view', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [{ type: 'tuple', components: [{ name: 'id', type: 'uint256' }, { name: 'client', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'evaluator', type: 'address' }, { name: 'description', type: 'string' }, { name: 'budget', type: 'uint256' }, { name: 'expiredAt', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'hook', type: 'address' }] }] }] as const
export const ERC8183_EVENTS = [
  { type: 'event', name: 'JobCreated', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'client', type: 'address', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'evaluator', type: 'address', indexed: false }, { name: 'expiredAt', type: 'uint256', indexed: false }, { name: 'hook', type: 'address', indexed: false }] },
  { type: 'event', name: 'ProviderSet', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'provider', type: 'address', indexed: true }] },
  { type: 'event', name: 'BudgetSet', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'JobFunded', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'client', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'JobSubmitted', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'deliverable', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'JobCompleted', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'evaluator', type: 'address', indexed: true }, { name: 'reason', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'JobRejected', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'rejector', type: 'address', indexed: true }, { name: 'reason', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'JobExpired', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'PaymentReleased', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'provider', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Refunded', anonymous: false, inputs: [{ name: 'jobId', type: 'uint256', indexed: true }, { name: 'client', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
] as const
export interface ArcErc8183JobEvidence { kind: 'erc8183.job'; network: string; chainId: number; contract: Address; id: string; client: Address; provider: Address; evaluator: Address; description: string; budget: string; expiredAt: string; status: ArcJobStatus; hook: Address; interpretation: string }
export interface ArcErc8183EventEvidence { kind: 'erc8183.event'; network: string; chainId: number; contract: Address; eventName: string; statusAfter?: ArcJobStatus; args: Record<string, string | number | boolean>; transactionHash?: Hex; blockNumber?: string; blockHash?: Hex; logIndex?: number; interpretation: string }
export async function observeErc8183Job(client: ArcReadClient, jobId: bigint, env: Record<string, string | undefined> = process.env): Promise<ArcErc8183JobEvidence> {
  const profile = arcProfile(env)
  const raw = await client.readContract({ address: profile.agenticCommerce as Address, abi: ERC8183_ABI, functionName: 'getJob', args: [jobId] }) as { id: bigint; client: Address; provider: Address; evaluator: Address; description: string; budget: bigint; expiredAt: bigint; status: number; hook: Address }
  return modelJob({ ...raw, network: profile.caip2, chainId: profile.chainId, contract: profile.agenticCommerce as Address })
}
export const modelJob = (job: { status: number } & Record<string, unknown>): ArcErc8183JobEvidence => ({ kind: 'erc8183.job', network: String(job.network ?? 'unknown'), chainId: Number(job.chainId ?? 0), contract: String(job.contract ?? '0x0000000000000000000000000000000000000000') as Address, id: String(job.id ?? 'unknown'), client: String(job.client ?? '0x0000000000000000000000000000000000000000') as Address, provider: String(job.provider ?? '0x0000000000000000000000000000000000000000') as Address, evaluator: String(job.evaluator ?? '0x0000000000000000000000000000000000000000') as Address, description: String(job.description ?? ''), budget: String(job.budget ?? '0'), expiredAt: String(job.expiredAt ?? '0'), status: ERC8183_STATUS[Number(job.status)] ?? 'Unknown', hook: String(job.hook ?? '0x0000000000000000000000000000000000000000') as Address, interpretation: jobLimitation })

const STATUS_AFTER_EVENT: Record<string, ArcJobStatus | undefined> = { JobCreated: 'Open', BudgetSet: 'Open', JobFunded: 'Funded', JobSubmitted: 'Submitted', JobCompleted: 'Completed', JobRejected: 'Rejected', JobExpired: 'Expired' }
function normalizeArgs(args: Record<string, unknown>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !/^\d+$/.test(key)).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value as string | number | boolean]))
}
export function decodeErc8183Event(log: ArcLogInput, env: Record<string, string | undefined> = process.env): ArcErc8183EventEvidence | undefined {
  const profile = arcProfile(env)
  const contract = profile.agenticCommerce as Address
  if (log.address.toLowerCase() !== contract.toLowerCase()) return undefined
  try {
    const decoded = decodeEventLog({ abi: ERC8183_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as { eventName: string; args: Record<string, unknown> }
    return {
      kind: 'erc8183.event', network: profile.caip2, chainId: profile.chainId, contract, eventName: decoded.eventName,
      ...(STATUS_AFTER_EVENT[decoded.eventName] ? { statusAfter: STATUS_AFTER_EVENT[decoded.eventName] } : {}), args: normalizeArgs(decoded.args),
      ...(log.transactionHash ? { transactionHash: log.transactionHash } : {}),
      ...(log.blockNumber !== undefined && log.blockNumber !== null ? { blockNumber: log.blockNumber.toString() } : {}),
      ...(log.blockHash ? { blockHash: log.blockHash } : {}),
      ...(log.logIndex !== undefined && log.logIndex !== null ? { logIndex: log.logIndex } : {}),
      interpretation: jobLimitation,
    }
  } catch { return undefined }
}
export function decodeErc8183Receipt(receipt: ArcReceiptInput, env: Record<string, string | undefined> = process.env): ArcErc8183EventEvidence[] {
  return receipt.logs.flatMap((log) => {
    const evidence = decodeErc8183Event(log, env)
    return evidence ? [evidence] : []
  })
}
