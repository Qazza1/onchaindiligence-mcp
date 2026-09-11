/**
 * Small, explicit settlement-network registry. This is not a generic chain
 * plugin system: it names the small set of EVM networks OCD can independently
 * observe today and one canonical payment asset on each.
 */
import type { Chain } from 'viem'
import { base, mainnet, tempo } from 'viem/chains'

export const BASE_CAIP2 = 'eip155:8453'
export const ETHEREUM_CAIP2 = 'eip155:1'
export const TEMPO_CAIP2 = 'eip155:4217'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
// Circle's authoritative USDC contract-address registry, verified 2026-09-11:
// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const ETHEREUM_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
// Tempo's documented genesis TIP-20 USD stablecoin. Unlike USDC on Base and
// Ethereum, pathUSD is the narrowest canonical Tempo payment asset for this
// initial observer scope. It is ERC-20-transfer compatible and has 6 decimals.
// https://docs.tempo.xyz/protocol/exchange/pathUSD
export const TEMPO_PATH_USD = '0x20c0000000000000000000000000000000000000'

export type SettlementFinalityPolicy =
  | 'base-usdc-safe-head.v1'
  | 'ethereum-usdc-finalized-head.v1'
  | 'tempo-tip20-finalized-head.v1'
export interface SettlementNetworkConfig {
  caip2: typeof BASE_CAIP2 | typeof ETHEREUM_CAIP2 | typeof TEMPO_CAIP2
  chain: Chain
  rpcEnvVar: 'BASE_RPC_URL' | 'ETHEREUM_RPC_URL' | 'TEMPO_RPC_URL'
  minConfirmationsEnvVar: 'BASE_MIN_CONFIRMATIONS' | null
  /** A documented public RPC may be used as a default; production may override it. */
  defaultRpcUrl: string | null
  finalityPolicy: SettlementFinalityPolicy
  finalityBlockTag: 'safe' | 'finalized'
  assets: Record<string, { decimals: 6; symbol: 'USDC' | 'pathUSD' }>
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
  [TEMPO_CAIP2]: {
    caip2: TEMPO_CAIP2,
    chain: tempo,
    rpcEnvVar: 'TEMPO_RPC_URL',
    minConfirmationsEnvVar: null,
    // Tempo publishes this mainnet EVM JSON-RPC endpoint. Operators can set
    // TEMPO_RPC_URL for a managed endpoint without changing observation rules.
    defaultRpcUrl: 'https://rpc.tempo.xyz',
    // Tempo uses deterministic Simplex BFT finality. We nevertheless bind the
    // OCD evidence claim to the RPC's actual `finalized` head, not merely to
    // inclusion or a local confirmation count.
    finalityPolicy: 'tempo-tip20-finalized-head.v1',
    finalityBlockTag: 'finalized',
    assets: { [TEMPO_PATH_USD]: { decimals: 6, symbol: 'pathUSD' } },
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
