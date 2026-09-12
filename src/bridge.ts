/**
 * Strict Circle CCTP V2 Base -> Ethereum native-USDC bridge authorization
 * model (D3.6C). Narrow production scope, mirroring D3.6A/D3.6B: exactly
 * one route, one protocol, one asset pair. A bridge action has a source
 * chain, a destination chain, and a burn/mint identity -- none of which is
 * a payment recipient or a single-chain transfer amount, so this
 * deliberately does not enter the PAYMENT parser or Action Receipt v1.
 */
import { randomBytes } from 'node:crypto'
import { BASE_CAIP2, BASE_USDC, ETHEREUM_CAIP2, ETHEREUM_USDC } from './settlementNetworks.js'

export const BRIDGE_ACTION_SCHEMA = 'onchaindiligence.bridge-action.v1'
export const BRIDGE_ATTESTATION_PURPOSE = 'bridge-action'
export const CCTP_V2_PROTOCOL = 'circle-cctp-v2'

// Confirmed against circlefin/evm-cctp-contracts (src/v2) and
// developers.circle.com/cctp/evm-smart-contracts -- same address on every
// supported chain (deterministic CREATE2 deployment).
export const CCTP_V2_TOKEN_MESSENGER = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d'
export const CCTP_V2_MESSAGE_TRANSMITTER = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64'

/** Circle CCTP domain identifiers (NOT chain ids / CAIP-2) -- fixed per the approved profile. */
export const CCTP_DOMAIN_BASE = 6
export const CCTP_DOMAIN_ETHEREUM = 0

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^(0|[1-9][0-9]*)$/

export class BridgeInputError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeInputError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new BridgeInputError(`${label} has an unexpected field: ${key}`)
}
function address(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) throw new BridgeInputError(`${label} must be a 0x-prefixed EVM address`)
  return value.toLowerCase()
}
function atomic(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ATOMIC.test(value)) throw new BridgeInputError(`${label} must be a canonical non-negative atomic decimal string`)
  return value
}
function optionalAtomic(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return atomic(value, label)
}
function strings(value: unknown, label: string): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new BridgeInputError(`${label} must be an array of strings or null`)
  return value
}

export interface BridgeAction {
  kind: 'BRIDGE'
  protocol: typeof CCTP_V2_PROTOCOL
  source_network: typeof BASE_CAIP2
  destination_network: typeof ETHEREUM_CAIP2
  source_asset: typeof BASE_USDC
  destination_asset: typeof ETHEREUM_USDC
  max_source_atomic: string
  min_destination_atomic: string
  recipient: string
}

export interface BridgePolicy {
  allowed_source_networks: string[] | null
  allowed_destination_networks: string[] | null
  allowed_source_assets: string[] | null
  allowed_destination_assets: string[] | null
  allowed_protocols: string[] | null
  max_source_atomic: string | null
  min_destination_atomic: string | null
  exact_recipient: string | null
}

export interface BridgeCheck { id: string; result: 'PASS' | 'FAIL'; summary: string }
export interface BridgeDecisionResult { status: 'ALLOW' | 'BLOCK'; authorized: boolean; reasons: string[] }
export interface ParsedBridgeInput { action: BridgeAction; policy: BridgePolicy }

/**
 * Only Base -> Ethereum canonical-USDC via Circle CCTP V2 is accepted.
 * Every field the caller supplies is still validated against that exact
 * profile rather than silently coerced, so a caller requesting anything
 * else gets a precise rejection, not a surprising substitution.
 */
export function parseBridgeInput(raw: unknown): ParsedBridgeInput {
  const body = object(raw, 'body')
  rejectUnknown(body, ['action', 'policy'], 'body')
  const rawAction = object(body.action, 'action')
  rejectUnknown(rawAction, ['kind', 'protocol', 'source_network', 'destination_network', 'source_asset', 'destination_asset', 'max_source_atomic', 'min_destination_atomic', 'recipient'], 'action')
  if (rawAction.kind !== 'BRIDGE') throw new BridgeInputError('action.kind must be "BRIDGE"')
  if (rawAction.protocol !== CCTP_V2_PROTOCOL) throw new BridgeInputError(`action.protocol must be "${CCTP_V2_PROTOCOL}"`)
  if (rawAction.source_network !== BASE_CAIP2) throw new BridgeInputError(`bridge observation currently supports only source_network ${BASE_CAIP2}`)
  if (rawAction.destination_network !== ETHEREUM_CAIP2) throw new BridgeInputError(`bridge observation currently supports only destination_network ${ETHEREUM_CAIP2}`)
  const sourceAsset = address(rawAction.source_asset, 'action.source_asset')
  if (sourceAsset !== BASE_USDC) throw new BridgeInputError('bridge observation currently supports only canonical Base USDC as source_asset')
  const destinationAsset = address(rawAction.destination_asset, 'action.destination_asset')
  if (destinationAsset !== ETHEREUM_USDC) throw new BridgeInputError('bridge observation currently supports only canonical Ethereum USDC as destination_asset')
  const maxSource = atomic(rawAction.max_source_atomic, 'action.max_source_atomic')
  const minDestination = atomic(rawAction.min_destination_atomic, 'action.min_destination_atomic')
  if (BigInt(maxSource) === 0n) throw new BridgeInputError('action.max_source_atomic must be greater than zero')
  if (BigInt(minDestination) === 0n) throw new BridgeInputError('action.min_destination_atomic must be greater than zero')
  const action: BridgeAction = {
    kind: 'BRIDGE', protocol: CCTP_V2_PROTOCOL, source_network: BASE_CAIP2, destination_network: ETHEREUM_CAIP2,
    source_asset: BASE_USDC, destination_asset: ETHEREUM_USDC, max_source_atomic: maxSource, min_destination_atomic: minDestination,
    recipient: address(rawAction.recipient, 'action.recipient'),
  }

  const rawPolicy = object(body.policy, 'policy')
  rejectUnknown(rawPolicy, ['allowed_source_networks', 'allowed_destination_networks', 'allowed_source_assets', 'allowed_destination_assets', 'allowed_protocols', 'max_source_atomic', 'min_destination_atomic', 'exact_recipient', 'acknowledge_unconstrained'], 'policy')
  const policy: BridgePolicy = {
    allowed_source_networks: strings(rawPolicy.allowed_source_networks, 'policy.allowed_source_networks'),
    allowed_destination_networks: strings(rawPolicy.allowed_destination_networks, 'policy.allowed_destination_networks'),
    allowed_source_assets: strings(rawPolicy.allowed_source_assets, 'policy.allowed_source_assets')?.map((v) => address(v, 'policy.allowed_source_assets entry')) ?? null,
    allowed_destination_assets: strings(rawPolicy.allowed_destination_assets, 'policy.allowed_destination_assets')?.map((v) => address(v, 'policy.allowed_destination_assets entry')) ?? null,
    allowed_protocols: strings(rawPolicy.allowed_protocols, 'policy.allowed_protocols'),
    max_source_atomic: optionalAtomic(rawPolicy.max_source_atomic, 'policy.max_source_atomic'),
    min_destination_atomic: optionalAtomic(rawPolicy.min_destination_atomic, 'policy.min_destination_atomic'),
    exact_recipient: rawPolicy.exact_recipient == null ? null : address(rawPolicy.exact_recipient, 'policy.exact_recipient'),
  }
  const constrained = Object.values(policy).some((v) => v !== null)
  if (!constrained && rawPolicy.acknowledge_unconstrained !== true) throw new BridgeInputError('policy has no constraints; set acknowledge_unconstrained: true only when that is intentional')
  return { action, policy }
}

export function evaluateBridgePolicy(input: ParsedBridgeInput): { decision: BridgeDecisionResult; checks: BridgeCheck[] } {
  const { action, policy } = input
  const checks: BridgeCheck[] = []
  const failures: string[] = []
  const check = (id: string, pass: boolean, summary: string) => { checks.push({ id, result: pass ? 'PASS' : 'FAIL', summary }); if (!pass) failures.push(summary) }
  if (policy.allowed_source_networks) check('source-network-allowed', policy.allowed_source_networks.includes(action.source_network), 'Source network is within the configured bridge policy.')
  if (policy.allowed_destination_networks) check('destination-network-allowed', policy.allowed_destination_networks.includes(action.destination_network), 'Destination network is within the configured bridge policy.')
  if (policy.allowed_source_assets) check('source-asset-allowed', policy.allowed_source_assets.includes(action.source_asset), 'Source asset is within the configured bridge policy.')
  if (policy.allowed_destination_assets) check('destination-asset-allowed', policy.allowed_destination_assets.includes(action.destination_asset), 'Destination asset is within the configured bridge policy.')
  if (policy.allowed_protocols) check('protocol-allowed', policy.allowed_protocols.includes(action.protocol), 'Bridge protocol is within the configured policy.')
  if (policy.max_source_atomic !== null) check('max-source-atomic', BigInt(action.max_source_atomic) <= BigInt(policy.max_source_atomic), 'Maximum source amount is within policy.')
  if (policy.min_destination_atomic !== null) check('min-destination-atomic', BigInt(action.min_destination_atomic) >= BigInt(policy.min_destination_atomic), 'Minimum destination amount meets policy.')
  if (policy.exact_recipient !== null) check('recipient-exact', action.recipient === policy.exact_recipient, 'Recipient matches the configured exact policy value.')
  if (failures.length) return { decision: { status: 'BLOCK', authorized: false, reasons: failures }, checks }
  return { decision: { status: 'ALLOW', authorized: true, reasons: ['All configured bridge policy checks passed. OCD does not authorize wallet execution or bridge submission.'] }, checks }
}

export function generateBridgeOperationId(): string { return `OCD-BRG-${randomBytes(20).toString('base64url')}` }
