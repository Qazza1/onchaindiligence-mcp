/**
 * Small, explicit settlement-network registry. This is not a generic chain
 * plugin system: it names the two EVM networks OCD can independently observe
 * today and the one canonical USDC contract accepted on each.
 */
import type { Chain } from 'viem'
import { base, mainnet } from 'viem/chains'

export const BASE_CAIP2 = 'eip155:8453'
export const ETHEREUM_CAIP2 = 'eip155:1'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
// Circle's authoritative USDC contract-address registry, verified 2026-09-11:
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const ETHEREUM_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

export type SettlementFinalityPolicy = 'base-usdc-safe-head.v1' | 'ethereum-usdc-finalized-head.v1'
export interface SettlementNetworkConfig {
  caip2: typeof BASE_CAIP2 | typeof ETHEREUM_CAIP2
  chain: Chain
  rpcEnvVar: 'BASE_RPC_URL' | 'ETHEREUM_RPC_URL'
  minConfirmationsEnvVar: 'BASE_MIN_CONFIRMATIONS' | null
  /** Base alone retains its existing public RPC fallback. Ethereum is opt-in. */
  defaultRpcUrl: string | null
  finalityPolicy: SettlementFinalityPolicy
  finalityBlockTag: 'safe' | 'finalized'
  assets: Record<string, { decimals: 6; symbol: 'USDC' }>
}

export const SETTLEMENT_NETWORKS: Record<string, SettlementNetworkConfig> = {
  [BASE_CAIP2]: {
    caip2: BASE_CAIP2,
    chain: base,
    rpcEnvVar: 'BASE_RPC_URL',
    minConfirmationsEnvVar: 'BASE_MIN_CONFIRMATIONS',
    defaultRpcUrl: 'https://mainnet.base.org',
    finalityPolicy: 'base-usdc-safe-head.v1',
    finalityBlockTag: 'safe',
    assets: { [BASE_USDC]: { decimals: 6, symbol: 'USDC' } },
  },
  [ETHEREUM_CAIP2]: {
    caip2: ETHEREUM_CAIP2,
    chain: mainnet,
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    minConfirmationsEnvVar: null,
    defaultRpcUrl: null,
    finalityPolicy: 'ethereum-usdc-finalized-head.v1',
    finalityBlockTag: 'finalized',
    assets: { [ETHEREUM_USDC]: { decimals: 6, symbol: 'USDC' } },
  },
}

export function getSettlementNetwork(network: string): SettlementNetworkConfig | null {
  return SETTLEMENT_NETWORKS[network] ?? null
}

export function getConfiguredRpcUrl(config: SettlementNetworkConfig): string | null {
  return process.env[config.rpcEnvVar] || config.defaultRpcUrl
}

export function getNetworkMinConfirmations(config: SettlementNetworkConfig): number | null {
  if (!config.minConfirmationsEnvVar) return null
  const raw = process.env[config.minConfirmationsEnvVar]
  const parsed = raw ? Number(raw) : NaN
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
}
