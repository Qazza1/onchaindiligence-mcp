/** Strict Lido stETH submit() authorization model (D3.6D). */
import { randomBytes } from 'node:crypto'
import { ETHEREUM_CAIP2 } from './settlementNetworks.js'

export const STAKING_ACTION_SCHEMA = 'onchaindiligence.staking-action.v1'
export const STAKING_ATTESTATION_PURPOSE = 'staking-action'
export const LIDO_STETH_SUBMIT_PROTOCOL = 'lido-steth-submit'
export const LIDO_STETH_PROXY = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'
/** CAIP-19 native ETH identity: Ethereum chain namespace + SLIP-44 ETH coin type. */
export const ETH_NATIVE_ASSET = 'eip155:1/slip44:60'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^[1-9][0-9]*$/
const UINT256_MAX = (2n ** 256n - 1n).toString()

export class StakingInputError extends Error {}
export type StakingDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'UNKNOWN'
export interface StakingAction {
  kind: 'STAKE'
  protocol: typeof LIDO_STETH_SUBMIT_PROTOCOL
  network: typeof ETHEREUM_CAIP2
  input_asset: typeof ETH_NATIVE_ASSET
  staker: string
  max_amount_wei: string
}
export interface StakingPolicy {
  allowed_networks: string[] | null
  allowed_protocols: string[] | null
  exact_staker: string | null
  max_amount_wei: string | null
}
export interface StakingCheck { id: string; result: 'PASS' | 'FAIL'; summary: string }
export interface StakingDecisionResult { status: StakingDecision; authorized: boolean; reasons: string[] }
export interface ParsedStaking { action: StakingAction; policy: StakingPolicy }

const obj = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StakingInputError(`${name} must be an object`)
  return value as Record<string, unknown>
}
const reject = (value: Record<string, unknown>, keys: string[], name: string) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new StakingInputError(`${name} has an unexpected field: ${key}`)
}
const address = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new StakingInputError(`${name} must be a 0x-prefixed EVM address`)
  return value.toLowerCase()
}
const atomic = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !ATOMIC.test(value) || BigInt(value) > BigInt(UINT256_MAX)) throw new StakingInputError(`${name} must be a canonical positive uint256 decimal string`)
  return value
}
const optionalAtomic = (value: unknown, name: string): string | null => value === undefined || value === null ? null : atomic(value, name)
const stringList = (value: unknown, name: string): string[] | null => {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new StakingInputError(`${name} must be an array of strings or null`)
  return value
}

export function parseStakingInput(raw: unknown): ParsedStaking {
  const body = obj(raw, 'body'); reject(body, ['action', 'policy'], 'body')
  const a = obj(body.action, 'action'); reject(a, ['kind', 'protocol', 'network', 'input_asset', 'staker', 'max_amount_wei'], 'action')
  if (a.kind !== 'STAKE') throw new StakingInputError('action.kind must be "STAKE"')
  if (a.protocol !== LIDO_STETH_SUBMIT_PROTOCOL) throw new StakingInputError(`action.protocol must be "${LIDO_STETH_SUBMIT_PROTOCOL}"`)
  if (a.network !== ETHEREUM_CAIP2) throw new StakingInputError(`staking observation currently supports only ${ETHEREUM_CAIP2}`)
  if (a.input_asset !== ETH_NATIVE_ASSET) throw new StakingInputError(`action.input_asset must be canonical native ETH identity ${ETH_NATIVE_ASSET}`)
  const action: StakingAction = { kind: 'STAKE', protocol: LIDO_STETH_SUBMIT_PROTOCOL, network: ETHEREUM_CAIP2, input_asset: ETH_NATIVE_ASSET, staker: address(a.staker, 'action.staker'), max_amount_wei: atomic(a.max_amount_wei, 'action.max_amount_wei') }
  const p = obj(body.policy, 'policy'); reject(p, ['allowed_networks', 'allowed_protocols', 'exact_staker', 'max_amount_wei', 'acknowledge_unconstrained'], 'policy')
  const policy: StakingPolicy = {
    allowed_networks: stringList(p.allowed_networks, 'policy.allowed_networks'),
    allowed_protocols: stringList(p.allowed_protocols, 'policy.allowed_protocols'),
    exact_staker: p.exact_staker === undefined || p.exact_staker === null ? null : address(p.exact_staker, 'policy.exact_staker'),
    max_amount_wei: optionalAtomic(p.max_amount_wei, 'policy.max_amount_wei'),
  }
  if (!Object.values(policy).some((value) => value !== null) && p.acknowledge_unconstrained !== true) throw new StakingInputError('policy has no constraints; set acknowledge_unconstrained: true only when intentional')
  return { action, policy }
}

export function evaluateStakingPolicy(input: ParsedStaking): { decision: StakingDecisionResult; checks: StakingCheck[] } {
  const { action, policy } = input
  const checks: StakingCheck[] = []
  const check = (id: string, pass: boolean, summary: string) => checks.push({ id, result: pass ? 'PASS' : 'FAIL', summary })
  if (policy.allowed_networks) check('network-allowed', policy.allowed_networks.includes(action.network), 'Network is within the configured staking policy.')
  if (policy.allowed_protocols) check('protocol-allowed', policy.allowed_protocols.includes(action.protocol), 'Protocol is within the configured staking policy.')
  if (policy.exact_staker !== null) check('staker-exact', policy.exact_staker === action.staker, 'Staker matches the configured exact address.')
  if (policy.max_amount_wei !== null) check('amount-within-max', BigInt(action.max_amount_wei) <= BigInt(policy.max_amount_wei), 'Requested ETH deposit is within the configured wei maximum.')
  const failed = checks.filter((check) => check.result === 'FAIL')
  return {
    decision: failed.length
      ? { status: 'BLOCK', authorized: false, reasons: failed.map((check) => check.summary) }
      : { status: 'ALLOW', authorized: true, reasons: ['All configured staking policy checks passed. OCD does not authorize wallet execution.'] },
    checks,
  }
}

export const generateStakingOperationId = () => `OCD-STK-${randomBytes(20).toString('base64url')}`
