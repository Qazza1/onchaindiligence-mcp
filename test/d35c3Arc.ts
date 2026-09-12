import assert from 'node:assert/strict'
import { ARC_TESTNET, arcProfile } from '../src/arc/config.js'
import { modelValidation, observeErc8004Identity, observeErc8004Validation } from '../src/arc/erc8004.js'
import { ERC8183_STATUS, jobLimitation, modelJob, observeErc8183Job } from '../src/arc/erc8183.js'
const addr = '0x1111111111111111111111111111111111111111' as const
const hash = `0x${'11'.repeat(32)}` as const
assert.equal(ARC_TESTNET.caip2, 'eip155:5042002')
assert.equal(arcProfile({ ARC_CHAIN_ID: '77' }).caip2, 'eip155:77')
assert.throws(() => arcProfile({ ARC_CHAIN_ID: '0' }))
assert.throws(() => arcProfile({ ARC_USDC_ADDRESS: 'bad' }))
assert.equal(ARC_TESTNET.finality.requiredConfirmations, 1)
const validation = modelValidation({ kind: 'erc8004.validation', network: 'eip155:5042002', chainId: 5042002, registry: addr, requestHash: hash, validator: addr, agentId: '1', response: 100, responseHash: hash, tag: 'attested', lastUpdate: '1' })
assert.match(validation.interpretation, /not OCD/)
assert.doesNotMatch(validation.interpretation, /^VALID/)
for (const [n, s] of Object.entries(ERC8183_STATUS)) assert.equal(modelJob({ status: Number(n) }).status, s)
assert.equal(modelJob({ status: 99 }).status, 'Unknown')
assert.match(jobLimitation, /not independent proof/)
const reads: unknown[] = [addr, 'ipfs://agent.json', [addr, 42n, 100, hash, 'kyc', 123n], { id: 9n, client: addr, provider: addr, evaluator: addr, description: 'test job', budget: 5n, expiredAt: 99n, status: 3, hook: addr }]
const client = { readContract: async () => reads.shift()! }
const identity = await observeErc8004Identity(client, 42n)
assert.equal(identity.agentId, '42'); assert.equal(identity.metadataUri, 'ipfs://agent.json')
const observedValidation = await observeErc8004Validation(client, hash)
assert.equal(observedValidation.response, 100); assert.equal(observedValidation.validator, addr)
const job = await observeErc8183Job(client, 9n)
assert.equal(job.status, 'Completed'); assert.equal(job.budget, '5'); assert.equal(job.network, 'eip155:5042002')
console.log('D3.5C3-PRE Arc tests passed')
