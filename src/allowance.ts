/**
 * Strict, additive ERC-20 allowance authorization model (D3.6A).
 *
 * This deliberately does not enter the PAYMENT parser or Action Receipt v1:
 * an allowance has a spender and an intent, neither of which is a payment
 * recipient or transfer amount. Initial production scope is Base canonical
 * USDC; all amounts are uint256 atomic units, never JS numbers.
 */
import { randomBytes } from 'node:crypto'
import { BASE_CAIP2, BASE_USDC } from './settlementNetworks.js'

export const ERC20_ALLOWANCE_ACTION_SCHEMA = 'onchaindiligence.erc20-allowance-action.v1'
export const ERC20_ALLOWANCE_ATTESTATION_PURPOSE = 'erc20-allowance-action'
export const UINT256_MAX = ((1n << 256n) - 1n).toString()

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^(0|[1-9][0-9]*)$/
const CAIP2 = /^([a-z0-9][a-z0-9-]{0,31}):([A-Za-z0-9-]{1,32})$/

export type AllowanceIntent = 'SET_ALLOWANCE' | 'REVOKE'
export type AllowanceDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK' | 'UNKNOWN'
export type UnlimitedAllowancePolicy = 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK'
export type CheckResult = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface AllowanceAction {
  kind: 'ERC20_ALLOWANCE'
  network: typeof BASE_CAIP2
  token: typeof BASE_USDC
  owner: string | null
  spender: string
  amount_atomic: string
  intent: AllowanceIntent
}

export interface AllowancePolicy {
  allowed_networks: string[] | null
  allowed_tokens: string[] | null
  allowed_spenders: string[] | null
  max_allowance_atomic: string | null
  exact_allowance_atomic: string | null
  revoke_only: boolean
  /** Absent deliberately means REQUIRE_APPROVAL, never an implicit unlimited ALLOW. */
  unlimited_allowance: UnlimitedAllowancePolicy | null
}

export interface AllowanceCheck { id: string; result: CheckResult; summary: string }
export interface AllowanceDecisionResult { status: AllowanceDecision; authorized: boolean | null; reasons: string[] }

export interface ParsedAllowanceInput {
  action: AllowanceAction
  policy: AllowancePolicy
  options: { observe_current_allowance: boolean }
}

export class AllowanceInputError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AllowanceInputError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AllowanceInputError(`${label} has an unexpected field: ${key}`)
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AllowanceInputError(`${label} must be a non-empty string`)
  return value
}
function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return string(value, label)
}
function address(value: unknown, label: string): string {
  const output = string(value, label)
  if (!EVM_ADDRESS.test(output)) throw new AllowanceInputError(`${label} must be a 0x-prefixed EVM address`)
  return output.toLowerCase()
}
function optionalAddress(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return address(value, label)
}
function atomic(value: unknown, label: string): string {
  const output = string(value, label)
  if (!ATOMIC.test(output)) throw new AllowanceInputError(`${label} must be a canonical non-negative uint256 decimal string`)
  if (BigInt(output) > BigInt(UINT256_MAX)) throw new AllowanceInputError(`${label} exceeds uint256 maximum`)
  return output
}
function optionalAtomic(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return atomic(value, label)
}
function strings(value: unknown, label: string): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new AllowanceInputError(`${label} must be an array of strings or null`)
  return value
}

export function parseAllowanceInput(raw: unknown): ParsedAllowanceInput {
  const input = object(raw, 'body')
  rejectUnknown(input, ['action', 'policy', 'options'], 'body')
  const rawAction = object(input.action, 'action')
  rejectUnknown(rawAction, ['kind', 'network', 'token', 'owner', 'spender', 'amount_atomic', 'intent'], 'action')
  if (rawAction.kind !== 'ERC20_ALLOWANCE') throw new AllowanceInputError('action.kind must be "ERC20_ALLOWANCE"')
  const network = string(rawAction.network, 'action.network')
  if (!CAIP2.test(network)) throw new AllowanceInputError('action.network must be a CAIP-2 identifier')
  if (network !== BASE_CAIP2) throw new AllowanceInputError(`ERC-20 allowance observation currently supports only ${BASE_CAIP2}`)
  const token = address(rawAction.token, 'action.token')
  if (token !== BASE_USDC) throw new AllowanceInputError('ERC-20 allowance observation currently supports canonical Base USDC only')
  const intent = rawAction.intent
  if (intent !== 'SET_ALLOWANCE' && intent !== 'REVOKE') throw new AllowanceInputError('action.intent must be "SET_ALLOWANCE" or "REVOKE"')
  const amount = atomic(rawAction.amount_atomic, 'action.amount_atomic')
  if (intent === 'REVOKE' && amount !== '0') throw new AllowanceInputError('REVOKE is represented only by approve(spender, 0)')
  if (intent === 'SET_ALLOWANCE' && amount === '0') throw new AllowanceInputError('use intent "REVOKE" for approve(spender, 0)')
  const action: AllowanceAction = { kind: 'ERC20_ALLOWANCE', network: BASE_CAIP2, token: BASE_USDC, owner: optionalAddress(rawAction.owner, 'action.owner'), spender: address(rawAction.spender, 'action.spender'), amount_atomic: amount, intent }

  const rawPolicy = object(input.policy, 'policy')
  rejectUnknown(rawPolicy, ['allowed_networks', 'allowed_tokens', 'allowed_spenders', 'max_allowance_atomic', 'exact_allowance_atomic', 'revoke_only', 'unlimited_allowance', 'acknowledge_unconstrained'], 'policy')
  const allowedNetworks = strings(rawPolicy.allowed_networks, 'policy.allowed_networks')
  if (allowedNetworks) for (const entry of allowedNetworks) if (!CAIP2.test(entry)) throw new AllowanceInputError('policy.allowed_networks contains a non-CAIP-2 identifier')
  const allowedTokens = strings(rawPolicy.allowed_tokens, 'policy.allowed_tokens')?.map((entry) => address(entry, 'policy.allowed_tokens entry')) ?? null
  const allowedSpenders = strings(rawPolicy.allowed_spenders, 'policy.allowed_spenders')?.map((entry) => address(entry, 'policy.allowed_spenders entry')) ?? null
  const revokeOnly = rawPolicy.revoke_only ?? false
  if (typeof revokeOnly !== 'boolean') throw new AllowanceInputError('policy.revoke_only must be boolean')
  const unlimited = rawPolicy.unlimited_allowance === undefined || rawPolicy.unlimited_allowance === null ? null : rawPolicy.unlimited_allowance
  if (unlimited !== null && unlimited !== 'ALLOW' && unlimited !== 'REQUIRE_APPROVAL' && unlimited !== 'BLOCK') throw new AllowanceInputError('policy.unlimited_allowance must be ALLOW, REQUIRE_APPROVAL, BLOCK, or null')
  const policy: AllowancePolicy = {
    allowed_networks: allowedNetworks,
    allowed_tokens: allowedTokens,
    allowed_spenders: allowedSpenders,
    max_allowance_atomic: optionalAtomic(rawPolicy.max_allowance_atomic, 'policy.max_allowance_atomic'),
    exact_allowance_atomic: optionalAtomic(rawPolicy.exact_allowance_atomic, 'policy.exact_allowance_atomic'),
    revoke_only: revokeOnly,
    unlimited_allowance: unlimited,
  }
  const constrained = policy.allowed_networks || policy.allowed_tokens || policy.allowed_spenders || policy.max_allowance_atomic !== null || policy.exact_allowance_atomic !== null || policy.revoke_only || policy.unlimited_allowance !== null
  if (!constrained && rawPolicy.acknowledge_unconstrained !== true) throw new AllowanceInputError('policy has no constraints; set acknowledge_unconstrained: true only when that is intentional')
  const rawOptions = input.options === undefined ? {} : object(input.options, 'options')
  rejectUnknown(rawOptions, ['observe_current_allowance'], 'options')
  if (rawOptions.observe_current_allowance !== undefined && typeof rawOptions.observe_current_allowance !== 'boolean') throw new AllowanceInputError('options.observe_current_allowance must be boolean')
  return { action, policy, options: { observe_current_allowance: rawOptions.observe_current_allowance === true } }
}

export function isUnlimitedAllowance(amountAtomic: string): boolean { return amountAtomic === UINT256_MAX }

export function evaluateAllowancePolicy(input: ParsedAllowanceInput): { decision: AllowanceDecisionResult; checks: AllowanceCheck[] } {
  const { action, policy } = input
  const checks: AllowanceCheck[] = []
  const failures: string[] = []
  const requiresApproval: string[] = []
  const check = (id: string, pass: boolean, summary: string) => { checks.push({ id, result: pass ? 'PASS' : 'FAIL', summary }); if (!pass) failures.push(summary) }
  if (policy.allowed_networks) check('network-allowed', policy.allowed_networks.includes(action.network), 'Network is within the configured allowance policy.')
  if (policy.allowed_tokens) check('token-allowed', policy.allowed_tokens.includes(action.token), 'Token is within the configured allowance policy.')
  if (policy.allowed_spenders) check('spender-allowed', policy.allowed_spenders.includes(action.spender), 'Spender is within the configured allowance policy.')
  if (policy.revoke_only) check('revoke-only', action.intent === 'REVOKE', 'Policy permits revocation only.')
  if (policy.max_allowance_atomic !== null) check('allowance-within-max', BigInt(action.amount_atomic) <= BigInt(policy.max_allowance_atomic), 'Requested allowance is within the configured atomic maximum.')
  if (policy.exact_allowance_atomic !== null) check('allowance-exact', action.amount_atomic === policy.exact_allowance_atomic, 'Requested allowance equals the configured exact atomic amount.')
  if (isUnlimitedAllowance(action.amount_atomic)) {
    const handling = policy.unlimited_allowance ?? 'REQUIRE_APPROVAL'
    checks.push({ id: 'unlimited-allowance', result: handling === 'BLOCK' ? 'FAIL' : handling === 'ALLOW' ? 'PASS' : 'UNKNOWN', summary: `Unlimited uint256-max allowance policy: ${handling}.` })
    if (handling === 'BLOCK') failures.push('Unlimited allowance is blocked by policy.')
    if (handling === 'REQUIRE_APPROVAL') requiresApproval.push('Unlimited allowance requires explicit approval by policy.')
  }
  if (failures.length) return { decision: { status: 'BLOCK', authorized: false, reasons: failures }, checks }
  if (requiresApproval.length) return { decision: { status: 'REQUIRE_APPROVAL', authorized: null, reasons: requiresApproval }, checks }
  return { decision: { status: 'ALLOW', authorized: true, reasons: ['All configured allowance policy checks passed. OCD does not authorize wallet execution.'] }, checks }
}

export function generateAllowanceOperationId(): string { return `OCD-ALW-${randomBytes(20).toString('base64url')}` }
