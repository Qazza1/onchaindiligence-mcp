/** Strict Base USDC -> WETH, direct Uniswap V3 SwapRouter02 authorization. */
import { randomBytes } from 'node:crypto'
import { BASE_CAIP2, BASE_USDC } from './settlementNetworks.js'

export const SWAP_ACTION_SCHEMA = 'onchaindiligence.swap-action.v1'
export const SWAP_ATTESTATION_PURPOSE = 'swap-action'
export const UNISWAP_V3_SWAP_ROUTER02_BASE = '0x2626664c2603336e57b271c5c0b26f421741e481'
export const BASE_WETH = '0x4200000000000000000000000000000000000006'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^(0|[1-9][0-9]*)$/

export class SwapInputError extends Error {}
export type SwapDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'UNKNOWN'

export interface SwapAction {
  kind: 'SWAP'; network: typeof BASE_CAIP2; input_asset: typeof BASE_USDC; max_input_atomic: string
  output_asset: typeof BASE_WETH; min_output_atomic: string; recipient: string
  router: typeof UNISWAP_V3_SWAP_ROUTER02_BASE; deadline: string | null; payer: string
}
export interface SwapPolicy {
  allowed_networks: string[] | null; allowed_input_assets: string[] | null; allowed_output_assets: string[] | null
  allowed_routers: string[] | null; max_input_atomic: string | null; min_output_atomic: string | null; exact_recipient: string | null
}
export interface SwapCheck { id: string; result: 'PASS' | 'FAIL'; summary: string }
export interface SwapDecisionResult { status: SwapDecision; authorized: boolean; reasons: string[] }
export interface ParsedSwap { action: SwapAction; policy: SwapPolicy }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SwapInputError(`${name} must be an object`)
  return value as Record<string, unknown>
}
function rejectUnknownFields(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new SwapInputError(`${name} has an unexpected field: ${key}`)
}
function address(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new SwapInputError(`${name} must be an EVM address`)
  return value.toLowerCase()
}
function atomic(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ATOMIC.test(value)) throw new SwapInputError(`${name} must be a canonical non-negative atomic decimal string`)
  return value
}
function optionalAtomic(value: unknown, name: string): string | null { return value === undefined || value === null ? null : atomic(value, name) }
function stringList(value: unknown, name: string): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new SwapInputError(`${name} must be an array of strings or null`)
  return value.map((item) => item.toLowerCase())
}

export function parseSwapInput(raw: unknown): ParsedSwap {
  const body = object(raw, 'body')
  rejectUnknownFields(body, ['action', 'policy'], 'body')
  const actionInput = object(body.action, 'action')
  rejectUnknownFields(actionInput, ['kind', 'network', 'input_asset', 'max_input_atomic', 'output_asset', 'min_output_atomic', 'recipient', 'router', 'deadline', 'payer'], 'action')
  if (actionInput.kind !== 'SWAP') throw new SwapInputError('action.kind must be "SWAP"')
  if (actionInput.network !== BASE_CAIP2) throw new SwapInputError(`swap observation currently supports only ${BASE_CAIP2}`)
  const action: SwapAction = {
    kind: 'SWAP', network: BASE_CAIP2, input_asset: address(actionInput.input_asset, 'action.input_asset') as typeof BASE_USDC,
    max_input_atomic: atomic(actionInput.max_input_atomic, 'action.max_input_atomic'), output_asset: address(actionInput.output_asset, 'action.output_asset') as typeof BASE_WETH,
    min_output_atomic: atomic(actionInput.min_output_atomic, 'action.min_output_atomic'), recipient: address(actionInput.recipient, 'action.recipient'),
    router: address(actionInput.router, 'action.router') as typeof UNISWAP_V3_SWAP_ROUTER02_BASE, deadline: optionalAtomic(actionInput.deadline, 'action.deadline'), payer: address(actionInput.payer, 'action.payer'),
  }
  if (action.input_asset !== BASE_USDC || action.output_asset !== BASE_WETH || action.router !== UNISWAP_V3_SWAP_ROUTER02_BASE) throw new SwapInputError('only direct Base canonical-USDC to Base-WETH via Uniswap V3 SwapRouter02 is supported')
  if (BigInt(action.max_input_atomic) === 0n || BigInt(action.min_output_atomic) === 0n) throw new SwapInputError('max_input_atomic and min_output_atomic must be greater than zero')
  const policyInput = object(body.policy, 'policy')
  rejectUnknownFields(policyInput, ['allowed_networks', 'allowed_input_assets', 'allowed_output_assets', 'allowed_routers', 'max_input_atomic', 'min_output_atomic', 'exact_recipient', 'acknowledge_unconstrained'], 'policy')
  const policy: SwapPolicy = {
    allowed_networks: stringList(policyInput.allowed_networks, 'policy.allowed_networks'), allowed_input_assets: stringList(policyInput.allowed_input_assets, 'policy.allowed_input_assets'),
    allowed_output_assets: stringList(policyInput.allowed_output_assets, 'policy.allowed_output_assets'), allowed_routers: stringList(policyInput.allowed_routers, 'policy.allowed_routers'),
    max_input_atomic: optionalAtomic(policyInput.max_input_atomic, 'policy.max_input_atomic'), min_output_atomic: optionalAtomic(policyInput.min_output_atomic, 'policy.min_output_atomic'),
    exact_recipient: policyInput.exact_recipient === undefined || policyInput.exact_recipient === null ? null : address(policyInput.exact_recipient, 'policy.exact_recipient'),
  }
  if (!Object.values(policy).some((value) => value !== null) && policyInput.acknowledge_unconstrained !== true) throw new SwapInputError('policy has no constraints; set acknowledge_unconstrained: true only when intentional')
  return { action, policy }
}

export function evaluateSwapPolicy(input: ParsedSwap): { decision: SwapDecisionResult; checks: SwapCheck[] } {
  const { action, policy } = input
  const checks: SwapCheck[] = []
  const check = (id: string, pass: boolean, summary: string) => checks.push({ id, result: pass ? 'PASS' : 'FAIL', summary })
  if (policy.allowed_networks) check('network-allowed', policy.allowed_networks.includes(action.network), 'Network is within policy.')
  if (policy.allowed_input_assets) check('input-asset-allowed', policy.allowed_input_assets.includes(action.input_asset), 'Input asset is within policy.')
  if (policy.allowed_output_assets) check('output-asset-allowed', policy.allowed_output_assets.includes(action.output_asset), 'Output asset is within policy.')
  if (policy.allowed_routers) check('router-allowed', policy.allowed_routers.includes(action.router), 'Router is within policy.')
  if (policy.max_input_atomic !== null) check('maximum-input', BigInt(action.max_input_atomic) <= BigInt(policy.max_input_atomic), 'Maximum input is within policy.')
  if (policy.min_output_atomic !== null) check('minimum-output', BigInt(action.min_output_atomic) >= BigInt(policy.min_output_atomic), 'Minimum output meets policy.')
  if (policy.exact_recipient !== null) check('recipient-exact', action.recipient === policy.exact_recipient, 'Recipient matches policy.')
  const failed = checks.filter((item) => item.result === 'FAIL')
  return { decision: failed.length ? { status: 'BLOCK', authorized: false, reasons: failed.map((item) => item.summary) } : { status: 'ALLOW', authorized: true, reasons: ['All configured swap policy checks passed. OCD does not authorize wallet execution.'] }, checks }
}

export const generateSwapOperationId = () => `OCD-SWP-${randomBytes(20).toString('base64url')}`
