import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { ARC_TESTNET, arcProfile } from '../src/arc/config.js'
import { decodeErc8004IdentityMint, decodeErc8004Receipt, decodeErc8004ValidationEvent, ERC8004_IDENTITY_EVENTS, ERC8004_VALIDATION_EVENTS, modelValidation, observeErc8004Identity, observeErc8004Reputation, observeErc8004Validation } from '../src/arc/erc8004.js'
import { decodeErc8183Event, decodeErc8183Receipt, ERC8183_EVENTS, ERC8183_STATUS, jobLimitation, modelJob, observeErc8183Job } from '../src/arc/erc8183.js'
const addr = '0x1111111111111111111111111111111111111111' as const
const other = '0x2222222222222222222222222222222222222222' as const
const zero = '0x0000000000000000000000000000000000000000' as const
const hash = `0x${'11'.repeat(32)}` as const
const otherHash = `0x${'22'.repeat(32)}` as const
const topicList = (value: unknown) => value as readonly Hex[]
assert.equal(ARC_TESTNET.caip2, 'eip155:5042002')
assert.equal(ARC_TESTNET.rpcUrl, 'https://rpc.testnet.arc.io')
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
assert.match(job.interpretation, /not independent proof/)

const emptyReputation = await observeErc8004Reputation({ readContract: async () => [] }, 42n)
assert.deepEqual(emptyReputation.clients, []); assert.deepEqual(emptyReputation.feedback, []); assert.match(emptyReputation.interpretation, /No client/)
const reputationReads: unknown[] = [[addr], [[addr], [1n], [-5n], [1], ['quality'], ['week'], [false]]]
const reputation = await observeErc8004Reputation({ readContract: async () => reputationReads.shift()! }, 42n)
assert.deepEqual(reputation.feedback[0], { client: addr, feedbackIndex: '1', value: '-5', valueDecimals: 1, tag1: 'quality', tag2: 'week', isRevoked: false })
assert.match(reputation.interpretation, /Raw registry feedback only/)

const identityMintTopics = topicList(encodeEventTopics({ abi: ERC8004_IDENTITY_EVENTS, eventName: 'Transfer', args: { from: zero, to: addr, tokenId: 42n } }))
const identityMint = decodeErc8004IdentityMint({ address: ARC_TESTNET.identityRegistry as typeof addr, data: '0x', topics: identityMintTopics, transactionHash: hash, blockNumber: 9n, blockHash: otherHash, logIndex: 2 })
assert.equal(identityMint?.kind, 'erc8004.identity-mint'); assert.equal(identityMint?.agentId, '42'); assert.equal(identityMint?.transactionHash, hash)
assert.equal(decodeErc8004IdentityMint({ address: other, data: '0x', topics: identityMintTopics }), undefined)

const requestTopics = topicList(encodeEventTopics({ abi: ERC8004_VALIDATION_EVENTS, eventName: 'ValidationRequest', args: { validatorAddress: other, agentId: 42n, requestHash: hash } }))
const request = decodeErc8004ValidationEvent({ address: ARC_TESTNET.validationRegistry as typeof addr, topics: requestTopics, data: encodeAbiParameters([{ type: 'string' }], ['ipfs://request']), transactionHash: hash })
assert.equal(request?.kind, 'erc8004.validation-request'); if (request?.kind === 'erc8004.validation-request') assert.equal(request.requestUri, 'ipfs://request')
const responseTopics = topicList(encodeEventTopics({ abi: ERC8004_VALIDATION_EVENTS, eventName: 'ValidationResponse', args: { validatorAddress: other, agentId: 42n, requestHash: hash } }))
const response = decodeErc8004ValidationEvent({ address: ARC_TESTNET.validationRegistry as typeof addr, topics: responseTopics, data: encodeAbiParameters([{ type: 'uint8' }, { type: 'string' }, { type: 'bytes32' }, { type: 'string' }], [100, 'ipfs://response', otherHash, 'reachable']) })
assert.equal(response?.kind, 'erc8004.validation-response'); if (response?.kind === 'erc8004.validation-response') { assert.equal(response.response, 100); assert.doesNotMatch(response.interpretation, /^VALID/) }
assert.equal(decodeErc8004ValidationEvent({ address: ARC_TESTNET.validationRegistry as typeof addr, topics: [hash], data: '0x12' }), undefined)
assert.equal(decodeErc8004ValidationEvent({ address: other, topics: requestTopics, data: encodeAbiParameters([{ type: 'string' }], ['ipfs://request']) }), undefined)
assert.deepEqual(decodeErc8004Receipt({ logs: [{ address: other, topics: [], data: '0x' }, { address: ARC_TESTNET.identityRegistry as typeof addr, topics: identityMintTopics, data: '0x' }] }).map((event) => event.kind), ['erc8004.identity-mint'])

const jobCreated = decodeErc8183Event({ address: ARC_TESTNET.agenticCommerce as typeof addr, topics: topicList(encodeEventTopics({ abi: ERC8183_EVENTS, eventName: 'JobCreated', args: { jobId: 9n, client: addr, provider: other } })), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [addr, 999n, zero]), transactionHash: hash })
assert.equal(jobCreated?.eventName, 'JobCreated'); assert.equal(jobCreated?.statusAfter, 'Open'); assert.equal(jobCreated?.args.jobId, '9')
const funded = decodeErc8183Event({ address: ARC_TESTNET.agenticCommerce as typeof addr, topics: topicList(encodeEventTopics({ abi: ERC8183_EVENTS, eventName: 'JobFunded', args: { jobId: 9n, client: addr } })), data: encodeAbiParameters([{ type: 'uint256' }], [100000n]) })
assert.equal(funded?.statusAfter, 'Funded'); assert.equal(funded?.args.amount, '100000')
const submitted = decodeErc8183Event({ address: ARC_TESTNET.agenticCommerce as typeof addr, topics: topicList(encodeEventTopics({ abi: ERC8183_EVENTS, eventName: 'JobSubmitted', args: { jobId: 9n, provider: other } })), data: encodeAbiParameters([{ type: 'bytes32' }], [hash]) })
assert.equal(submitted?.statusAfter, 'Submitted')
const completed = decodeErc8183Event({ address: ARC_TESTNET.agenticCommerce as typeof addr, topics: topicList(encodeEventTopics({ abi: ERC8183_EVENTS, eventName: 'JobCompleted', args: { jobId: 9n, evaluator: addr } })), data: encodeAbiParameters([{ type: 'bytes32' }], [otherHash]) })
assert.equal(completed?.statusAfter, 'Completed'); assert.match(completed?.interpretation ?? '', /not independent proof/); assert.doesNotMatch(completed?.interpretation ?? '', /service delivery is verified/i)
assert.equal(decodeErc8183Event({ address: other, topics: [], data: '0x' }), undefined)
assert.equal(decodeErc8183Event({ address: ARC_TESTNET.agenticCommerce as typeof addr, topics: [hash], data: '0x12' }), undefined)
assert.deepEqual(decodeErc8183Receipt({ logs: [{ address: other, topics: [], data: '0x' }, { address: ARC_TESTNET.agenticCommerce as typeof addr, topics: topicList(encodeEventTopics({ abi: ERC8183_EVENTS, eventName: 'JobCompleted', args: { jobId: 9n, evaluator: addr } })), data: encodeAbiParameters([{ type: 'bytes32' }], [otherHash]) }] }).map((event) => event.statusAfter), ['Completed'])
console.log('D3.5C3-PRE Arc tests passed')
