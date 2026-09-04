/**
 * lifecycleCore.ts — the pinned facts and pre-signature safety gates for the
 * first real OCD commerce lifecycle (D2.2A/D2.2B), shared verbatim between:
 *
 *   - scripts/first-commerce-lifecycle.ts   (Node/terminal, private-key buyer)
 *   - operator/src/main.ts                  (browser, injected-wallet buyer)
 *
 * Deliberately isomorphic: no Node-only builtins (no `Buffer`, no `node:*`
 * imports) so this file can be bundled unmodified into a browser page. Base64
 * decoding uses `atob`/`TextDecoder`, both global in modern Node and browsers.
 *
 * Nothing here signs anything or holds a key. This is exactly the "abort
 * before signing" boundary — every mismatch throws LifecycleAbortError before
 * the caller ever reaches a signer.
 */

export const BASE_URL = 'https://mcp.onchaindiligence.com'
export const RESOURCE_ORIGIN = BASE_URL
export const NETWORK = 'eip155:8453' // Base mainnet, CAIP-2
export const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base
export const RECIPIENT = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897' // OCD's own configured X402_RECIPIENT_ADDRESS

export const PER_CALL_ATOMIC = 10_000n // exactly $0.01 (USDC, 6 decimals)
export const AGGREGATE_MAX_ATOMIC = 20_000n // exactly $0.02 — the hard cap for the whole lifecycle

export const INSPECT_URL = `${BASE_URL}/inspect/payment`
export const PREFLIGHT_URL = `${BASE_URL}/x402/preflight-payment`
export const TARGET_SERVICE_URL = `${BASE_URL}/x402/screen/${RECIPIENT}`
export const FINALIZE_URL = `${BASE_URL}/receipts/finalize`
export const RECEIPTS_URL = (id: string) => `${BASE_URL}/receipts/${id}`
export const EXPLORER_URL = (id: string) => `https://onchaindiligence.com/r/${id}`
export const BAZAAR_DISCOVERY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources'

/** Thrown instead of process.exit()/throwing a bare Error, so every abort path is testable via assert.throws and safe to catch-and-display in a browser UI. */
export class LifecycleAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LifecycleAbortError'
  }
}

function fail(message: string): never {
  throw new LifecycleAbortError(message)
}

let totalSpentAtomic = 0n

/** Exported for tests that need to assert spend-tracking behavior in isolation; production code never resets this mid-run. */
export function resetSpendTrackerForTests(): void {
  totalSpentAtomic = 0n
}

export function currentSpentAtomic(): bigint {
  return totalSpentAtomic
}

export function reserveSpend(amount: bigint, label: string): void {
  if (amount !== PER_CALL_ATOMIC) {
    fail(`${label}: quoted amount ${amount} is not EXACTLY ${PER_CALL_ATOMIC} ($0.01) — refusing to pay`)
  }
  if (totalSpentAtomic + amount > AGGREGATE_MAX_ATOMIC) {
    fail(`${label}: would push aggregate spend to ${totalSpentAtomic + amount}, exceeding the hard cap of ${AGGREGATE_MAX_ATOMIC} ($0.02)`)
  }
  totalSpentAtomic += amount
}

/** The proposed target payment: $0.01 USDC to OCD's own recipient, for the screen_wallet resource. Identical object used for both the free inspection and the paid preflight. */
export function targetPaymentAction() {
  return {
    kind: 'PAYMENT' as const,
    resource: TARGET_SERVICE_URL,
    network: NETWORK,
    asset: ASSET,
    amount: '0.01',
    sender: null,
    recipient: RECIPIENT,
  }
}

export function strictPolicy() {
  return {
    max_amount: '0.01',
    allowed_networks: [NETWORK],
    allowed_assets: [ASSET],
    expected_recipient: RECIPIENT,
    allowed_resource_origins: [RESOURCE_ORIGIN],
  }
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function decodeChallenge(response: Response): any {
  const header = response.headers.get('payment-required')
  if (!header) fail(`${response.url}: 402 response carried no Payment-Required header`)
  try {
    return JSON.parse(base64ToUtf8(header as string))
  } catch {
    return fail(`${response.url}: Payment-Required header was not base64-encoded JSON`)
  }
}

/**
 * Decodes the post-payment X-PAYMENT-RESPONSE/PAYMENT-RESPONSE header. This
 * is a POST-payment sanity read, not a pre-payment safety gate (the real
 * safety gate is validateChallenge(), which runs and can abort BEFORE any
 * signing) — so this deliberately only hard-fails on the one unambiguous
 * field (`transaction`) rather than a strict network-string comparison, since
 * the settlement response's network field is not guaranteed to use the same
 * CAIP-2 convention as the payment requirements challenge.
 */
export function decodeSettlementResponse(header: string): { success: boolean; transaction: string; network: unknown; payer: unknown } {
  try {
    const decoded = JSON.parse(base64ToUtf8(header))
    if (typeof decoded.transaction !== 'string' || !decoded.transaction.startsWith('0x')) {
      fail('payment-response did not contain a valid transaction hash')
    }
    return decoded
  } catch (err) {
    if (err instanceof LifecycleAbortError) throw err
    return fail('payment-response header was not valid base64-encoded JSON')
  }
}

/** Validates a decoded x402 challenge against every pinned expectation. Returns the quoted atomic amount. Never mutates spend state — see reserveSpend. ABORTS (throws) before any caller could sign. */
export function validateChallenge(challenge: any, label: string): bigint {
  if (challenge.x402Version !== 2) fail(`${label}: unexpected x402 version ${challenge.x402Version} (expected 2)`)
  const accepts = challenge.accepts?.[0]
  if (!accepts) fail(`${label}: challenge contained no accepts entry`)
  if (accepts.scheme !== 'exact') fail(`${label}: unexpected scheme "${accepts.scheme}" (expected "exact")`)
  if (accepts.network !== NETWORK) fail(`${label}: network mismatch — quoted "${accepts.network}", pinned "${NETWORK}"`)
  if (String(accepts.asset).toLowerCase() !== ASSET.toLowerCase()) {
    fail(`${label}: asset mismatch — quoted "${accepts.asset}", pinned USDC "${ASSET}"`)
  }
  if (String(accepts.payTo).toLowerCase() !== RECIPIENT.toLowerCase()) {
    fail(`${label}: recipient mismatch — quoted "${accepts.payTo}", pinned "${RECIPIENT}". Refusing to pay an address that is not OCD's own.`)
  }
  let amount: bigint
  try {
    amount = BigInt(accepts.amount)
  } catch {
    return fail(`${label}: quoted amount "${accepts.amount}" is not an integer`)
  }
  if (amount !== PER_CALL_ATOMIC) {
    fail(`${label}: quoted amount ${amount} is not EXACTLY ${PER_CALL_ATOMIC} atomic units ($0.01) — refusing to pay`)
  }
  return amount
}
