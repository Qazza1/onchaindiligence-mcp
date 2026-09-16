import assert from 'node:assert/strict'
import { ARC_TESTNET, arcProfile } from '../src/arc/config.js'

const testnet = {
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  usdc: '0x3600000000000000000000000000000000000000',
  identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
  reputationRegistry: '0x8004b663056a597dffe9eccc1965a193b7388713',
  validationRegistry: '0x8004cb1bf31daf7788923b405b754f57aceb4272',
  agenticCommerce: '0x0747eef0706327138c69792bf28cd525089e4583',
} as const

const mainnetOverrides = {
  ARC_NETWORK: 'arc-mainnet',
  ARC_CHAIN_ID: '5042',
  ARC_RPC_URL: 'https://rpc.mainnet.arc.io',
  ARC_EXPLORER_URL: 'https://mainnet.example.explorer',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  ARC_ERC8004_IDENTITY_REGISTRY: '0x1000000000000000000000000000000000000001',
  ARC_ERC8004_REPUTATION_REGISTRY: '0x1000000000000000000000000000000000000002',
  ARC_ERC8004_VALIDATION_REGISTRY: '0x1000000000000000000000000000000000000003',
  ARC_ERC8183_AGENTIC_COMMERCE: '0x1000000000000000000000000000000000000004',
} as const

const zeroConfig = arcProfile({})
assert.equal(zeroConfig.network, 'arc-testnet')
assert.equal(zeroConfig.chainId, testnet.chainId)
assert.equal(zeroConfig.rpcUrl, testnet.rpcUrl)
assert.equal(zeroConfig.explorerUrl, testnet.explorerUrl)
assert.equal(zeroConfig.usdc, testnet.usdc)
assert.equal(zeroConfig.identityRegistry, testnet.identityRegistry)
assert.equal(zeroConfig.reputationRegistry, testnet.reputationRegistry)
assert.equal(zeroConfig.validationRegistry, testnet.validationRegistry)
assert.equal(zeroConfig.agenticCommerce, testnet.agenticCommerce)
assert.deepEqual(ARC_TESTNET, zeroConfig)

assert.throws(() => arcProfile({ ARC_NETWORK: 'arc-mainnet' }), /ARC_EXPLORER_URL is required/)
assert.throws(() => arcProfile({ ARC_NETWORK: 'arc-mainnet', ARC_EXPLORER_URL: 'https://mainnet.example.explorer' }), /ARC_ERC8004_IDENTITY_REGISTRY is required/)
assert.throws(() => arcProfile({ ...mainnetOverrides, ARC_ERC8004_IDENTITY_REGISTRY: undefined }), /ARC_ERC8004_IDENTITY_REGISTRY is required/)
assert.throws(() => arcProfile({ ...mainnetOverrides, ARC_ERC8004_REPUTATION_REGISTRY: undefined }), /ARC_ERC8004_REPUTATION_REGISTRY is required/)
assert.throws(() => arcProfile({ ...mainnetOverrides, ARC_ERC8004_VALIDATION_REGISTRY: undefined }), /ARC_ERC8004_VALIDATION_REGISTRY is required/)
assert.throws(() => arcProfile({ ...mainnetOverrides, ARC_ERC8183_AGENTIC_COMMERCE: undefined }), /ARC_ERC8183_AGENTIC_COMMERCE is required/)

const mainnet = arcProfile(mainnetOverrides)
assert.equal(mainnet.network, 'arc-mainnet')
assert.equal(mainnet.caip2, 'eip155:5042')
assert.equal(mainnet.rpcUrl, mainnetOverrides.ARC_RPC_URL)
assert.equal(mainnet.explorerUrl, mainnetOverrides.ARC_EXPLORER_URL)
assert.equal(mainnet.identityRegistry, mainnetOverrides.ARC_ERC8004_IDENTITY_REGISTRY)
assert.equal(mainnet.reputationRegistry, mainnetOverrides.ARC_ERC8004_REPUTATION_REGISTRY)
assert.equal(mainnet.validationRegistry, mainnetOverrides.ARC_ERC8004_VALIDATION_REGISTRY)
assert.equal(mainnet.agenticCommerce, mainnetOverrides.ARC_ERC8183_AGENTIC_COMMERCE)
assert.notEqual(mainnet.explorerUrl, testnet.explorerUrl)
assert.notEqual(mainnet.identityRegistry, testnet.identityRegistry)
assert.notEqual(mainnet.reputationRegistry, testnet.reputationRegistry)
assert.notEqual(mainnet.validationRegistry, testnet.validationRegistry)
assert.notEqual(mainnet.agenticCommerce, testnet.agenticCommerce)

const mainnetWithVerifiedDefaults = arcProfile({
  ARC_NETWORK: 'arc-mainnet',
  ARC_EXPLORER_URL: mainnetOverrides.ARC_EXPLORER_URL,
  ARC_ERC8004_IDENTITY_REGISTRY: mainnetOverrides.ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_REPUTATION_REGISTRY: mainnetOverrides.ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY: mainnetOverrides.ARC_ERC8004_VALIDATION_REGISTRY,
  ARC_ERC8183_AGENTIC_COMMERCE: mainnetOverrides.ARC_ERC8183_AGENTIC_COMMERCE,
})
assert.equal(mainnetWithVerifiedDefaults.caip2, 'eip155:5042')
assert.equal(mainnetWithVerifiedDefaults.rpcUrl, 'https://rpc.mainnet.arc.io')
assert.equal(mainnetWithVerifiedDefaults.usdc, testnet.usdc)

assert.throws(() => arcProfile({ ...mainnetOverrides, ARC_ERC8004_IDENTITY_REGISTRY: 'not-an-address' }), /ARC_ERC8004_IDENTITY_REGISTRY must be an EVM address/)
console.log('D3.5C3 Arc mainnet config tests passed')
