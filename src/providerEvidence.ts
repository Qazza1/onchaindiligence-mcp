/**
 * D3.4C1 provider evidence.
 *
 * This module records a normalized, content-addressed claim made by an
 * execution provider. It deliberately has no RPC client and never calls a
 * facilitator: supplied response material is a claim, not an OCD observation.
 * Only digests of raw response/reference material are retained.
 */
import { getExecutionBinding } from './executionBinding.js'
import { createProviderEvidence, type ProviderEvidenceRecord } from './db.js'
import { contentId } from './receipts.js'
import { isValidTransactionHash } from './settlement.js'

export const PROVIDER_EVIDENCE_SOURCE = 'CALLER_REPORTED_PROVIDER_RESPONSE' as const
export class ProviderEvidenceInputError extends Error {}

export interface ProviderEvidenceInput {
  provider: string
  providerVersion: string | null
  providerExecutionId: string | null
  correlationReference: string | null
  x402Version: string | null
  claimedState: 'SUCCEEDED' | 'FAILED'
  transactionHash: string | null
  network: string | null
  payer: string | null
  amountAtomic: string | null
  asset: string | null
  recipient: string | null
  failureCode: string | null
  failureDigest: string | null
  rawReferenceDigest: string | null
  executionRequestId: string | null
  providerEventId: string | null
  providerTimestamp: string | null
}

/**
 * PayBox's public request status is deliberately normalized separately from
 * the standard x402 facilitator response.  The two systems do not make the
 * same assertion: a PayBox request is a provider-side execution claim, not
 * an x402 settlement response and never an OCD chain observation.
 *
 * Only PayBox terminal states are accepted.  Pending approval/signature is
 * intentionally omitted rather than being recast as a failure; the existing
 * execution binding already represents a submitted-but-unresolved attempt.
 */
function parsePayBoxProviderEvidenceInput(body: Record<string, unknown>, rawClaim: Record<string, unknown>): ProviderEvidenceInput {
  const requestId = optionalString(rawClaim.request_id, 'paybox_response.request_id', 200)
  if (!requestId) throw new ProviderEvidenceInputError('paybox_response.request_id is required')
  const status = optionalString(rawClaim.status, 'paybox_response.status', 64)
  if (status !== 'success' && status !== 'denied' && status !== 'error') {
    throw new ProviderEvidenceInputError('paybox_response.status must be one of: success, denied, error (pending states are not terminal provider evidence)')
  }
  const payment = object(rawClaim.payment) ? rawClaim.payment : null
  const resourceResponse = object(rawClaim.response) ? rawClaim.response : null
  const rawReferenceDigest = optionalDigest(body.raw_reference_digest, 'raw_reference_digest') ?? contentId({
    provider: 'paybox', request_id: requestId, status,
    output_id: optionalString(rawClaim.output_id, 'paybox_response.output_id', 200),
    audit_id: optionalString(rawClaim.audit_id, 'paybox_response.audit_id', 200),
    payment: payment ? {
      gateway: payment.gateway === true, status: optionalString(payment.status, 'paybox_response.payment.status', 64),
      ok: payment.ok === true, network: optionalString(payment.network, 'paybox_response.payment.network', 160),
      scheme: optionalString(payment.scheme, 'paybox_response.payment.scheme', 64),
    } : null,
    response: resourceResponse ? {
      status: typeof resourceResponse.status === 'number' && Number.isSafeInteger(resourceResponse.status) ? resourceResponse.status : null,
      ok: resourceResponse.ok === true,
    } : null,
  })
  const failureDigest = optionalDigest(body.error_digest, 'error_digest')
  const failureCode = status === 'success' ? null : status === 'denied' ? 'PAYBOX_DENIED' : 'PAYBOX_ERROR'
  const timestamp = optionalString(body.provider_timestamp, 'provider_timestamp', 64)
  if (timestamp !== null && Number.isNaN(Date.parse(timestamp))) throw new ProviderEvidenceInputError('provider_timestamp must be an ISO timestamp, or null')

  return {
    provider: 'paybox',
    providerVersion: optionalString(body.provider_version, 'provider_version', 120),
    providerExecutionId: requestId,
    correlationReference: `paybox:${requestId}`,
    x402Version: null,
    claimedState: status === 'success' ? 'SUCCEEDED' : 'FAILED',
    transactionHash: null,
    // A gateway response can report the payment network.  Amount, asset,
    // payer and recipient are intentionally left null unless a future
    // PayBox public response actually supplies them; frozen OCD action data
    // is not rewritten as a provider assertion.
    network: payment ? optionalString(payment.network, 'paybox_response.payment.network', 160) : null,
    payer: null,
    amountAtomic: null,
    asset: null,
    recipient: null,
    failureCode,
    failureDigest,
    rawReferenceDigest,
    executionRequestId: optionalString(body.execution_request_id, 'execution_request_id'),
    // output_id is the documented non-secret, provider-generated result
    // identity. audit_id remains only in the digest, avoiding a new schema
    // field with ambiguous semantics.
    providerEventId: optionalString(rawClaim.output_id, 'paybox_response.output_id', 200),
    providerTimestamp: timestamp,
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, name: string, max = 512): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ProviderEvidenceInputError(`${name} must be a non-empty string (max ${max} characters), or null`)
  return value
}

function optionalDigest(value: unknown, name: string): string | null {
  const result = optionalString(value, name, 80)
  if (result !== null && !/^sha256:[0-9a-fA-F]{64}$/.test(result) && !/^sha256:[A-Za-z0-9_-]{43}$/.test(result)) {
    throw new ProviderEvidenceInputError(`${name} must be a sha256 digest, or null`)
  }
  return result
}

function optionalAddress(value: unknown, name: string): string | null {
  const result = optionalString(value, name, 42)
  if (result !== null && !/^0x[0-9a-fA-F]{40}$/.test(result)) throw new ProviderEvidenceInputError(`${name} must be a 0x-prefixed EVM address, or null`)
  return result
}

/**
 * Standard x402 settle response adapter. Both camelCase and snake_case are
 * accepted only for common interoperability; stored output is normalized.
 * `raw_response` is intentionally not accepted. Its digest/reference may be
 * supplied instead, so credentials or payment payloads are never persisted.
 */
export function parseProviderEvidenceInput(body: unknown): ProviderEvidenceInput {
  if (!object(body)) throw new ProviderEvidenceInputError('body must be a JSON object')
  if (body.paybox_response !== undefined) {
    if (!object(body.paybox_response)) throw new ProviderEvidenceInputError('paybox_response must be a JSON object')
    return parsePayBoxProviderEvidenceInput(body, body.paybox_response)
  }
  if (body.cdp_response !== undefined) {
    if (!object(body.cdp_response)) throw new ProviderEvidenceInputError('cdp_response must be a JSON object')
    return parseCdpProviderEvidenceInput(body, body.cdp_response)
  }
  const provider = optionalString(body.provider ?? 'x402-facilitator', 'provider', 120)!
  const rawClaim = body.x402_settle_response ?? body.claim ?? body
  if (!object(rawClaim)) throw new ProviderEvidenceInputError('x402_settle_response must be a JSON object')

  const success = rawClaim.success
  if (typeof success !== 'boolean') throw new ProviderEvidenceInputError('x402_settle_response.success must be a boolean')
  const transactionHash = optionalString(rawClaim.transaction ?? rawClaim.transaction_hash, 'x402_settle_response.transaction', 66)
  if (transactionHash !== null && !isValidTransactionHash(transactionHash)) throw new ProviderEvidenceInputError('x402_settle_response.transaction must be a 0x-prefixed 32-byte transaction hash, or null')
  const timestamp = optionalString(body.provider_timestamp ?? rawClaim.timestamp, 'provider_timestamp', 64)
  if (timestamp !== null && Number.isNaN(Date.parse(timestamp))) throw new ProviderEvidenceInputError('provider_timestamp must be an ISO timestamp, or null')

  const error = rawClaim.error
  const errorCode = typeof error === 'string' ? optionalString(error, 'x402_settle_response.error', 256) : object(error) ? optionalString(error.code, 'x402_settle_response.error.code', 128) : null
  const errorDigest = optionalDigest(body.error_digest ?? (object(error) ? error.digest : null), 'error_digest')
  if (!success && !errorCode && !errorDigest) throw new ProviderEvidenceInputError('a failed provider claim requires error information or error_digest')

  return {
    provider,
    providerVersion: optionalString(body.provider_version, 'provider_version', 120),
    providerExecutionId: optionalString(body.provider_execution_id ?? rawClaim.execution_id, 'provider_execution_id'),
    correlationReference: optionalString(body.correlation_reference ?? rawClaim.payment_id ?? rawClaim.request_id, 'correlation_reference'),
    x402Version: (() => {
      const value = rawClaim.x402Version ?? rawClaim.x402_version
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
      return optionalString(value, 'x402_settle_response.x402Version', 32)
    })(),
    claimedState: success ? 'SUCCEEDED' : 'FAILED',
    transactionHash,
    network: optionalString(rawClaim.network, 'x402_settle_response.network', 160),
    payer: optionalAddress(rawClaim.payer, 'x402_settle_response.payer'),
    amountAtomic: optionalString(rawClaim.amount_atomic ?? rawClaim.amount, 'x402_settle_response.amount', 100),
    asset: optionalString(rawClaim.asset, 'x402_settle_response.asset', 160),
    recipient: optionalAddress(rawClaim.recipient, 'x402_settle_response.recipient'),
    failureCode: errorCode,
    failureDigest: errorDigest,
    rawReferenceDigest: optionalDigest(body.raw_reference_digest ?? rawClaim.reference_digest, 'raw_reference_digest'),
    executionRequestId: optionalString(body.execution_request_id, 'execution_request_id'),
    providerEventId: optionalString(body.provider_event_id ?? rawClaim.event_id, 'provider_event_id'),
    providerTimestamp: timestamp,
  }
}

// ---------------------------------------------------------------------
// D3.4C3 -- Turnkey transaction-status webhook evidence.
//
// Turnkey's `SIGN_TRANSACTION` activity signs only -- it never broadcasts
// and carries no transaction hash, so it is never accepted as provider
// evidence by this module (see docs/PROVIDER_EVIDENCE.md's Turnkey
// section). The only path recognized here is the combined send/track
// lifecycle (`ethSendTransaction()` + the `transaction:status` webhook):
// BROADCASTING is non-terminal and is never persisted as a provider claim;
// INCLUDED (with no error) is SUCCEEDED; FAILED, and INCLUDED WITH an
// on-chain-revert `error`, are both FAILED -- current official Turnkey
// docs state INCLUDED "if the transaction reverted onchain, error is also
// present", so a reverted-but-included transaction is still an execution
// failure, not a success, even though a txHash exists.
//
// No current Turnkey documentation establishes a durable guaranteed
// linkage between `activityId` (the signing activity) and
// `sendTransactionStatusId` (the send/track identity) beyond both
// appearing on the same webhook message -- this module does NOT rely on
// activityId for correlation (sendTransactionStatusId is what becomes
// `correlationReference`/`provider_reference`); activityId is retained
// only inside `rawReferenceDigest` for traceability. See D3.4C3-PREP item 4.
// ---------------------------------------------------------------------
export const TURNKEY_EXECUTOR_IDENTITY = 'turnkey-base-usdc'

export type TurnkeyTransactionStatus = 'BROADCASTING' | 'INCLUDED' | 'FAILED'

/** True for a webhook message this module can accept as terminal provider evidence. BROADCASTING is never terminal. */
export function isTerminalTurnkeyStatus(status: unknown): status is 'INCLUDED' | 'FAILED' {
  return status === 'INCLUDED' || status === 'FAILED'
}

/**
 * Normalizes an ALREADY SIGNATURE-VERIFIED Turnkey `transaction:status`
 * webhook message into the existing ProviderEvidenceInput shape. Callers
 * MUST verify the webhook signature (turnkeyWebhookVerification.ts) and
 * MUST check isTerminalTurnkeyStatus() before calling this -- a
 * BROADCASTING message has no terminal claim to normalize.
 *
 * `webhookEventId` is the delivery's `X-Turnkey-Event-Id` header value --
 * NOT a body field -- documented as "stable across retry attempts for the
 * same webhook event", i.e. Turnkey's own retry-dedupe identity. This is
 * intentionally what becomes `providerEventId`, not `msg.activityId`: the
 * task's own instruction is to preserve the EXISTING semantic intent of
 * provider_event_id (a stable per-EVENT identifier), which the webhook
 * delivery id satisfies far more directly than the signing activity id
 * does. `activityId` is preserved in `rawReferenceDigest` instead (see
 * above) rather than overloading this field.
 */
export function parseTurnkeyWebhookEvidenceInput(body: unknown, webhookEventId: string): ProviderEvidenceInput {
  if (!object(body)) throw new ProviderEvidenceInputError('body must be a JSON object')
  if (body.type !== 'transaction:status') throw new ProviderEvidenceInputError('expected a transaction:status webhook message')
  const msg = object(body.msg) ? body.msg : null
  if (!msg) throw new ProviderEvidenceInputError('transaction:status webhook is missing msg')

  const sendTransactionStatusId = optionalString(msg.sendTransactionStatusId, 'msg.sendTransactionStatusId', 200)
  if (!sendTransactionStatusId) throw new ProviderEvidenceInputError('msg.sendTransactionStatusId is required')
  const activityId = optionalString(msg.activityId, 'msg.activityId', 200)
  const status = msg.status
  if (!isTerminalTurnkeyStatus(status)) {
    throw new ProviderEvidenceInputError('msg.status must be INCLUDED or FAILED to be recorded as terminal provider evidence (BROADCASTING is non-terminal)')
  }
  const caip2 = optionalString(msg.caip2, 'msg.caip2', 160)
  const idempotencyKey = optionalString(msg.idempotencyKey, 'msg.idempotencyKey', 200)
  const txHash = optionalString(msg.txHash, 'msg.txHash', 66)
  if (txHash !== null && !isValidTransactionHash(txHash)) throw new ProviderEvidenceInputError('msg.txHash must be a 0x-prefixed 32-byte transaction hash, or absent')
  const error = object(msg.error) ? msg.error : null
  const errorMessage = error ? optionalString(error.message, 'msg.error.message', 512) : null

  // status === 'FAILED' -> never landed onchain (no txHash per docs).
  // status === 'INCLUDED' with `error` present -> landed but reverted --
  // still a FAILED claim, with the txHash retained (the transaction exists
  // on-chain; it just didn't succeed).
  const reverted = status === 'INCLUDED' && error !== null
  const claimedState: 'SUCCEEDED' | 'FAILED' = status === 'FAILED' || reverted ? 'FAILED' : 'SUCCEEDED'
  const failureCode = status === 'FAILED' ? 'TURNKEY_FAILED' : reverted ? 'TURNKEY_REVERTED' : null
  const failureDigest = error ? contentId({ message: errorMessage, eth_revert_chain: error.eth ?? null, solana: error.solana ?? null }) : null

  const timestampRaw = msg.timestamp
  const providerTimestamp = (() => {
    if (typeof timestampRaw === 'number' && Number.isFinite(timestampRaw)) return new Date(timestampRaw * 1000).toISOString()
    if (typeof timestampRaw === 'string' && /^\d+$/.test(timestampRaw)) return new Date(Number(timestampRaw) * 1000).toISOString()
    return null
  })()

  return {
    provider: 'turnkey',
    providerVersion: 'v1',
    providerExecutionId: sendTransactionStatusId,
    correlationReference: `turnkey:${sendTransactionStatusId}`,
    x402Version: null,
    claimedState,
    transactionHash: txHash,
    network: caip2,
    // Turnkey's transaction:status message never asserts payer/amount/
    // asset/recipient -- these stay null so a provider claim can never be
    // mistaken for an assertion Turnkey did not actually make. The frozen
    // OCD mandate and the independent Base observation remain the only
    // sources for these fields.
    payer: null,
    amountAtomic: null,
    asset: null,
    recipient: null,
    failureCode,
    failureDigest,
    rawReferenceDigest: contentId({ activity_id: activityId, send_transaction_status_id: sendTransactionStatusId, status, caip2, idempotency_key: idempotencyKey }),
    executionRequestId: null, // resolved by the webhook route via provider_reference, then attached before recordProviderEvidence() is called
    providerEventId: webhookEventId,
    providerTimestamp,
  }
}

// ---------------------------------------------------------------------
// D3.4C4 -- Crossmint Agent Wallet transfer webhook evidence.
//
// Confirmed directly against current official Crossmint documentation
// (docs.crossmint.com, re-checked at implementation time, not from memory):
// wallet transfer webhooks (`wallets.transfer.in` / `wallets.transfer.out`)
// are ALWAYS terminal -- `data.status` is only ever `succeeded` or `failed`,
// with no pending/broadcasting intermediate state exposed at the webhook
// layer (unlike Turnkey's BROADCASTING). Only `wallets.transfer.out`
// (an OCD-controlled wallet sending funds out) is in scope for provider
// evidence about an OCD-authorized payment -- `wallets.transfer.in`
// describes funds arriving, which is not an execution claim about
// anything OCD authorized, and `wallets.signer.exported` is an unrelated
// security event; both are acknowledged but never parsed as evidence here.
//
// IDENTITY DISCIPLINE (the most important Crossmint-specific issue, per
// current docs): `data.transferId` (Crossmint's own transfer identity) and
// `data.onChain.txId` (the final on-chain transaction hash) are the only
// two identities the current webhook payload and Get Transaction API
// actually document. No `userOperationHash` field appears anywhere in
// current Crossmint API reference or webhook documentation -- this module
// therefore never looks for one and never risks collapsing a UserOperation
// hash into `transaction_hash`. If Crossmint later exposes one, it must be
// evaluated for its own guarantees before being treated as equivalent to
// `onChain.txId`, never assumed.
//
// Unlike Turnkey's webhook (which asserts nothing about payer/amount/
// asset/recipient), Crossmint's webhook DOES document `data.sender`,
// `data.recipient`, and `data.token` fields as its own claim -- so, per
// this module's own field-mapping rule ("populate ONLY fields the provider
// itself actually asserts"), those fields ARE populated here from
// Crossmint's claim, unlike the Turnkey/PayBox branches. This is still
// never treated as independent settlement evidence -- it is what Crossmint
// claims, checked against OCD's own frozen mandate and independent Base
// observation exactly like every other provider's claim.
// ---------------------------------------------------------------------
export const CROSSMINT_EXECUTOR_IDENTITY = 'crossmint-base-usdc'

export type CrossmintTransferEventType = 'wallets.transfer.in' | 'wallets.transfer.out'

/** Chain identifiers Crossmint documents for its wallet/transfer objects, mapped conservatively to CAIP-2 only where unambiguous. Anything else stays null -- never guessed. */
const CROSSMINT_CHAIN_TO_CAIP2: Readonly<Record<string, string>> = {
  base: 'eip155:8453',
}

/** True only for the one event type this module accepts as a provider execution claim (an OCD-controlled wallet sending funds out). `wallets.transfer.in` and `wallets.signer.exported` are real Crossmint events but are never terminal PROVIDER-EXECUTION evidence in this module's sense. */
export function isCrossmintOutboundTransferEvent(eventType: unknown): eventType is 'wallets.transfer.out' {
  return eventType === 'wallets.transfer.out'
}

/**
 * Normalizes an ALREADY SIGNATURE-VERIFIED Crossmint `wallets.transfer.out`
 * webhook message into the existing ProviderEvidenceInput shape. Callers
 * MUST verify the webhook signature (crossmintWebhookVerification.ts) and
 * MUST check isCrossmintOutboundTransferEvent(body.type) before calling
 * this.
 *
 * `svixEventId` is the delivery's `svix-id` header value -- not a body
 * field -- mirroring parseTurnkeyWebhookEvidenceInput()'s choice of the
 * transport-level per-delivery id over any payload-internal id, for the
 * same reason: it is the identifier Svix's own signed input is computed
 * over, and is Crossmint's documented stable per-event identity.
 */
export function parseCrossmintWebhookEvidenceInput(body: unknown, svixEventId: string): ProviderEvidenceInput {
  if (!object(body)) throw new ProviderEvidenceInputError('body must be a JSON object')
  if (body.type !== 'wallets.transfer.out') throw new ProviderEvidenceInputError('expected a wallets.transfer.out webhook message')
  const data = object(body.data) ? body.data : null
  if (!data) throw new ProviderEvidenceInputError('wallets.transfer.out webhook is missing data')

  const transferId = optionalString(data.transferId, 'data.transferId', 200)
  if (!transferId) throw new ProviderEvidenceInputError('data.transferId is required')
  const status = data.status
  if (status !== 'succeeded' && status !== 'failed') {
    throw new ProviderEvidenceInputError('data.status must be succeeded or failed (current Crossmint transfer webhooks carry no non-terminal status)')
  }

  const sender = object(data.sender) ? data.sender : null
  const recipient = object(data.recipient) ? data.recipient : null
  const token = object(data.token) ? data.token : null
  const onChain = object(data.onChain) ? data.onChain : null
  const error = object(data.error) ? data.error : null

  const txHash = onChain ? optionalString(onChain.txId, 'data.onChain.txId', 66) : null
  if (txHash !== null && !isValidTransactionHash(txHash)) throw new ProviderEvidenceInputError('data.onChain.txId must be a 0x-prefixed 32-byte transaction hash, or absent')

  const senderChain = sender ? optionalString(sender.chain, 'data.sender.chain', 64) : null
  const network = senderChain ? (CROSSMINT_CHAIN_TO_CAIP2[senderChain] ?? null) : null

  const failureCode = status === 'failed' ? (error ? optionalString(error.reason, 'data.error.reason', 128) ?? 'CROSSMINT_FAILED' : 'CROSSMINT_FAILED') : null
  const failureDigest = error
    ? contentId({ message: optionalString(error.message, 'data.error.message', 512), reason: optionalString(error.reason, 'data.error.reason', 128), revert: object(error.revert) ? error.revert : null })
    : null

  const completedAt = optionalString(data.completedAt, 'data.completedAt', 64)
  if (completedAt !== null && Number.isNaN(Date.parse(completedAt))) throw new ProviderEvidenceInputError('data.completedAt must be an ISO timestamp, or absent')

  return {
    provider: 'crossmint',
    providerVersion: 'v1',
    providerExecutionId: transferId,
    correlationReference: `crossmint:${transferId}`,
    x402Version: null,
    claimedState: status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
    transactionHash: txHash,
    network,
    // Crossmint's webhook DOES assert these -- unlike Turnkey, they are
    // populated from the provider's own claim (see this section's header).
    payer: sender ? optionalAddress(sender.address, 'data.sender.address') : null,
    amountAtomic: token ? optionalString(token.rawAmount, 'data.token.rawAmount', 100) : null,
    asset: token ? optionalAddress(token.contractAddress, 'data.token.contractAddress') : null,
    recipient: recipient ? optionalAddress(recipient.address, 'data.recipient.address') : null,
    failureCode,
    failureDigest,
    rawReferenceDigest: contentId({
      transfer_id: transferId,
      status,
      sender_locator: sender ? optionalString(sender.locator, 'data.sender.locator', 200) : null,
      recipient_locator: recipient ? optionalString(recipient.locator, 'data.recipient.locator', 200) : null,
      token_locator: token ? optionalString(token.locator, 'data.token.locator', 200) : null,
      svix_event_id: svixEventId,
    }),
    executionRequestId: null, // resolved by the webhook route via provider_reference, then attached before recordProviderEvidence() is called
    providerEventId: svixEventId,
    providerTimestamp: completedAt,
  }
}

// ---------------------------------------------------------------------
// D3.4C5 -- Coinbase Developer Platform (CDP) Server Wallet execution
// evidence.
//
// Confirmed directly against current official CDP documentation
// (docs.cdp.coinbase.com) at implementation time: this integrates at the
// Server Wallet v2 EVM Account (EOA) execution layer -- `sendEvmTransaction`
// -- never through AgentKit (an orchestration framework, not a provider
// identity) and never through Smart Accounts/user operations.
//
// THE CENTRAL IDENTITY FINDING: for an EOA Server Wallet send, current CDP
// documentation defines exactly ONE response identity --
// `transactionHash` -- with NO separate provider request/operation id
// distinct from it. This is confirmed, not assumed: the same underlying
// send response shape (`{ transactionHash, userOpHash }`, confirmed via
// CDP's "Send USDC on EVM" reference) populates exactly one of the two
// fields depending on account type, and for Smart Accounts, `userOpHash`
// IS a genuinely distinct identity from the eventual on-chain transaction
// hash -- which is exactly why Smart Account/user-operation execution is
// OUT OF SCOPE here: there is nothing to (mis)collapse for the EOA path
// this module targets, but a Smart Account path would need its own design
// to keep `userOpHash` and `transaction_hash` distinct, mirroring exactly
// the discipline D3.4C4 applied to Crossmint's UserOperation question.
//
// NO WEBHOOK, NO PROPRIETARY STATUS API: current CDP documentation exposes
// no wallet-transaction webhook/event mechanism for this send path, and
// `waitForTransactionReceipt()` is documented as a thin wrapper over
// standard EVM JSON-RPC (the same primitive OCD's own independent Base
// observer already uses) -- not a CDP-proprietary status lifecycle. So,
// per this milestone's own instruction not to invent a webhook that
// doesn't exist, CDP evidence is caller-reported through the SAME
// recovery-credential-gated endpoint x402/PayBox already use (a
// `cdp_response` branch here), submitted by CdpCommerceExecutor
// (onchaindiligence-sdk) once `sendEvmTransaction` returns -- mirroring
// PayBox's shape exactly (a webhook-less provider), not Turnkey's/
// Crossmint's (push-webhook-driven) shape.
//
// `claimedState: 'SUCCEEDED'` here means "CDP's server wallet successfully
// broadcast this transaction" -- the same character of claim x402's own
// `success: true` facilitator response already makes (a checked claim, not
// proof of on-chain inclusion) -- never "CDP confirms settlement". OCD's
// independent Base observer remains the only source of actual
// inclusion/revert/settlement truth, exactly as for every other provider.
// ---------------------------------------------------------------------
export const CDP_EXECUTOR_IDENTITY = 'cdp-base-usdc'

/** Chain identifiers a caller may report for CDP, mapped conservatively to CAIP-2 only where unambiguous. Anything else stays null -- never guessed. */
const CDP_CHAIN_TO_CAIP2: Readonly<Record<string, string>> = {
  base: 'eip155:8453',
}

function parseCdpProviderEvidenceInput(body: Record<string, unknown>, rawClaim: Record<string, unknown>): ProviderEvidenceInput {
  const status = rawClaim.status
  if (status !== 'success' && status !== 'failed') {
    throw new ProviderEvidenceInputError('cdp_response.status must be success or failed (a pending/unbroadcast attempt is not terminal provider evidence)')
  }
  const transactionHash = optionalString(rawClaim.transaction_hash, 'cdp_response.transaction_hash', 66)
  if (status === 'success' && !transactionHash) throw new ProviderEvidenceInputError('cdp_response.transaction_hash is required when status is success')
  if (transactionHash !== null && !isValidTransactionHash(transactionHash)) {
    throw new ProviderEvidenceInputError('cdp_response.transaction_hash must be a 0x-prefixed 32-byte transaction hash, or absent')
  }
  const network = (() => {
    const chain = optionalString(rawClaim.network, 'cdp_response.network', 64)
    return chain ? (CDP_CHAIN_TO_CAIP2[chain] ?? null) : null
  })()
  const errorObj = object(rawClaim.error) ? rawClaim.error : null
  const failureCode = status === 'failed' ? optionalString(errorObj?.code, 'cdp_response.error.code', 128) ?? 'CDP_SEND_FAILED' : null
  const failureDigest = errorObj ? contentId({ code: optionalString(errorObj.code, 'cdp_response.error.code', 128), message: optionalString(errorObj.message, 'cdp_response.error.message', 512) }) : null
  const timestamp = optionalString(body.provider_timestamp, 'provider_timestamp', 64)
  if (timestamp !== null && Number.isNaN(Date.parse(timestamp))) throw new ProviderEvidenceInputError('provider_timestamp must be an ISO timestamp, or null')

  // No separate provider request identity is documented for this send path
  // (see this section's header) -- the transaction hash IS the durable
  // identity. When the send never broadcast (status: failed, no hash), the
  // caller-supplied idempotency key stands in as the only identity CDP
  // itself confirms existed for this specific attempt.
  const idempotencyKey = optionalString(rawClaim.idempotency_key, 'cdp_response.idempotency_key', 200)
  const providerExecutionId = transactionHash ?? idempotencyKey
  if (!providerExecutionId) throw new ProviderEvidenceInputError('cdp_response must include transaction_hash (success) or idempotency_key (failed) to identify this attempt')

  return {
    provider: 'cdp',
    providerVersion: optionalString(body.provider_version, 'provider_version', 120),
    providerExecutionId,
    correlationReference: `cdp:${providerExecutionId}`,
    x402Version: null,
    claimedState: status === 'success' ? 'SUCCEEDED' : 'FAILED',
    transactionHash,
    network,
    // CDP's sendEvmTransaction response documents only transactionHash/
    // userOpHash -- it asserts nothing about payer/amount/asset/recipient,
    // so these stay null, same discipline as Turnkey's webhook section.
    payer: null,
    amountAtomic: null,
    asset: null,
    recipient: null,
    failureCode,
    failureDigest,
    rawReferenceDigest: optionalDigest(body.raw_reference_digest, 'raw_reference_digest') ?? contentId({ provider: 'cdp', status, network, idempotency_key: idempotencyKey }),
    executionRequestId: optionalString(body.execution_request_id, 'execution_request_id'),
    providerEventId: null,
    providerTimestamp: timestamp,
  }
}

function evidenceId(operationId: string, input: ProviderEvidenceInput): string {
  return contentId({ operationId, ...input, sourceAuthentication: PROVIDER_EVIDENCE_SOURCE })
}

export interface RecordProviderEvidenceDependencies {
  getExecutionBinding?: typeof getExecutionBinding
  createProviderEvidence?: typeof createProviderEvidence
}

/**
 * The only hard correlation check is an explicitly supplied execution binding
 * belonging to this operation. All other provider identifiers are retained as
 * claims for later reconciliation; none can alter observation/binding state.
 */
export async function recordProviderEvidence(operationId: string, input: ProviderEvidenceInput, deps: RecordProviderEvidenceDependencies = {}): Promise<{ created: boolean; evidence: ProviderEvidenceRecord }> {
  const getBinding = deps.getExecutionBinding ?? getExecutionBinding
  if (input.executionRequestId) {
    const binding = await getBinding(input.executionRequestId)
    if (!binding || binding.operationId !== operationId) throw new ProviderEvidenceInputError('execution_request_id does not belong to this operation')
    if (input.provider === 'paybox') {
      if (binding.executorIdentity !== 'paybox-x402-base-usdc') throw new ProviderEvidenceInputError('PayBox provider evidence requires a PayBox execution binding')
      if (binding.providerReference !== input.correlationReference) {
        throw new ProviderEvidenceInputError('PayBox request_id does not match the durable execution binding provider_reference')
      }
    }
    if (input.provider === 'turnkey') {
      if (binding.executorIdentity !== TURNKEY_EXECUTOR_IDENTITY) throw new ProviderEvidenceInputError('Turnkey provider evidence requires a Turnkey execution binding')
      if (binding.providerReference !== input.correlationReference) {
        throw new ProviderEvidenceInputError('Turnkey sendTransactionStatusId does not match the durable execution binding provider_reference')
      }
    }
    if (input.provider === 'crossmint') {
      if (binding.executorIdentity !== CROSSMINT_EXECUTOR_IDENTITY) throw new ProviderEvidenceInputError('Crossmint provider evidence requires a Crossmint execution binding')
      if (binding.providerReference !== input.correlationReference) {
        throw new ProviderEvidenceInputError('Crossmint transferId does not match the durable execution binding provider_reference')
      }
    }
    if (input.provider === 'cdp') {
      if (binding.executorIdentity !== CDP_EXECUTOR_IDENTITY) throw new ProviderEvidenceInputError('CDP provider evidence requires a CDP execution binding')
      if (binding.providerReference !== input.correlationReference) {
        throw new ProviderEvidenceInputError('CDP transaction identity does not match the durable execution binding provider_reference')
      }
    }
  }
  const create = deps.createProviderEvidence ?? createProviderEvidence
  return create({ evidenceId: evidenceId(operationId, input), operationId, ...input, sourceAuthentication: PROVIDER_EVIDENCE_SOURCE })
}
