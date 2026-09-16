/** Arc Testnet profile. Mainnet registry and explorer values must be explicitly configured. */
type ArcEnv = Record<string, string | undefined>

const address = /^0x[0-9a-fA-F]{40}$/

const ARC_TESTNET_DEFAULTS = {
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  usdc: '0x3600000000000000000000000000000000000000',
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  agenticCommerce: '0x0747EEf0706327138c69792bF28Cd525089e4583',
} as const

const ARC_MAINNET_DEFAULTS = {
  chainId: 5042,
  rpcUrl: 'https://rpc.mainnet.arc.io',
  usdc: '0x3600000000000000000000000000000000000000',
} as const

const chain = (value: string) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('ARC_CHAIN_ID must be a positive integer')
  return parsed
}

const valid = (value: string, name: string) => {
  if (!address.test(value)) throw new Error(`${name} must be an EVM address`)
  return value.toLowerCase()
}

const requiredMainnet = (env: ArcEnv, name: string) => {
  const value = env[name]
  if (!value) throw new Error(`${name} is required when ARC_NETWORK=arc-mainnet`)
  return value
}

function arcMainnetProfile(env: ArcEnv) {
  const chainId = chain(env.ARC_CHAIN_ID ?? String(ARC_MAINNET_DEFAULTS.chainId))
  return {
    network: 'arc-mainnet',
    chainId,
    caip2: `eip155:${chainId}`,
    rpcUrl: env.ARC_RPC_URL ?? ARC_MAINNET_DEFAULTS.rpcUrl,
    explorerUrl: requiredMainnet(env, 'ARC_EXPLORER_URL'),
    usdc: valid(env.ARC_USDC_ADDRESS ?? ARC_MAINNET_DEFAULTS.usdc, 'ARC_USDC_ADDRESS'),
    identityRegistry: valid(requiredMainnet(env, 'ARC_ERC8004_IDENTITY_REGISTRY'), 'ARC_ERC8004_IDENTITY_REGISTRY'),
    reputationRegistry: valid(requiredMainnet(env, 'ARC_ERC8004_REPUTATION_REGISTRY'), 'ARC_ERC8004_REPUTATION_REGISTRY'),
    validationRegistry: valid(requiredMainnet(env, 'ARC_ERC8004_VALIDATION_REGISTRY'), 'ARC_ERC8004_VALIDATION_REGISTRY'),
    agenticCommerce: valid(requiredMainnet(env, 'ARC_ERC8183_AGENTIC_COMMERCE'), 'ARC_ERC8183_AGENTIC_COMMERCE'),
    finality: { kind: 'deterministic' as const, requiredConfirmations: 1 },
  }
}

export function arcProfile(env: ArcEnv = process.env) {
  if (env.ARC_NETWORK === 'arc-mainnet') return arcMainnetProfile(env)

  const chainId = chain(env.ARC_CHAIN_ID ?? String(ARC_TESTNET_DEFAULTS.chainId))
  return {
    network: env.ARC_NETWORK ?? 'arc-testnet',
    chainId,
    caip2: `eip155:${chainId}`,
    rpcUrl: env.ARC_RPC_URL ?? ARC_TESTNET_DEFAULTS.rpcUrl,
    explorerUrl: env.ARC_EXPLORER_URL ?? ARC_TESTNET_DEFAULTS.explorerUrl,
    usdc: valid(env.ARC_USDC_ADDRESS ?? ARC_TESTNET_DEFAULTS.usdc, 'ARC_USDC_ADDRESS'),
    identityRegistry: valid(env.ARC_ERC8004_IDENTITY_REGISTRY ?? ARC_TESTNET_DEFAULTS.identityRegistry, 'ARC_ERC8004_IDENTITY_REGISTRY'),
    reputationRegistry: valid(env.ARC_ERC8004_REPUTATION_REGISTRY ?? ARC_TESTNET_DEFAULTS.reputationRegistry, 'ARC_ERC8004_REPUTATION_REGISTRY'),
    validationRegistry: valid(env.ARC_ERC8004_VALIDATION_REGISTRY ?? ARC_TESTNET_DEFAULTS.validationRegistry, 'ARC_ERC8004_VALIDATION_REGISTRY'),
    agenticCommerce: valid(env.ARC_ERC8183_AGENTIC_COMMERCE ?? ARC_TESTNET_DEFAULTS.agenticCommerce, 'ARC_ERC8183_AGENTIC_COMMERCE'),
    finality: { kind: 'deterministic' as const, requiredConfirmations: 1 },
  }
}

export const ARC_TESTNET = arcProfile({})
