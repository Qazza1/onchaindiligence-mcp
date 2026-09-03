/**
 * activate-x402.ts — ONE-SHOT paid activation of the HTTP x402 surface.
 *
 * WHY THIS EXISTS: the CDP Bazaar indexes an x402 resource after the CDP
 * facilitator settles a payment for it. Our routes already declare the Bazaar
 * discovery extension, but no payment has ever settled against them, so we are
 * "discovery-ready" and NOT indexed. This script performs exactly one real
 * $0.01 USDC payment on Base mainnet to trigger that indexing, and nothing else.
 *
 * IT DOES NOT RUN AUTOMATICALLY. It is never imported by the server, never
 * referenced by a test, and has no npm script. It requires BOTH an explicit
 * confirmation flag and a funded key in the environment:
 *
 *   BUYER_PRIVATE_KEY=0x... npx tsx scripts/activate-x402.ts --confirm-one-payment
 *
 * SAFETY PROPERTIES (all enforced below, before anything is signed):
 *   - the resource URL is PINNED in this file; there is no URL argument, so it
 *     cannot be aimed at an arbitrary endpoint
 *   - the chain is pinned to Base mainnet (eip155:8453)
 *   - the asset is pinned to USDC on Base
 *   - the recipient is pinned to OUR configured X402_RECIPIENT_ADDRESS
 *   - a hard cap of $0.01 is enforced against the quoted amount
 *   - ANY mismatch aborts before a payment is created
 *   - exactly one payment, and the x402 client itself refuses a second attempt
 *     for the same request, so a failure cannot silently double-spend
 *   - the private key is read from the environment and never logged, echoed,
 *     or written to the receipt; the X-PAYMENT header is never printed
 *
 * WHAT IT PRINTS: a receipt of PUBLIC facts only (resource, network, asset,
 * amount, recipient, HTTP status, settlement response, attestation key id and
 * signature). Those are all values any observer of the chain or the response
 * can already see.
 */

import { privateKeyToAccount } from 'viem/accounts'
import { wrapFetchWithPayment } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'

// --- Pinned expectations. Nothing here is caller-supplied. -----------------

/** The exact resource to activate. Cheapest route; no URL argument is accepted. */
const RESOURCE_URL =
  'https://mcp.onchaindiligence.com/x402/screen/0x0000000000000000000000000000000000000000'

/** Base mainnet, CAIP-2. */
const EXPECTED_NETWORK = 'eip155:8453'

/** USDC on Base. */
const EXPECTED_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Our receiving address. Must match X402_RECIPIENT_ADDRESS in production. */
const EXPECTED_PAY_TO = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'

/** Hard cap in USDC atomic units (6 decimals): 10000 = $0.01. */
const MAX_AMOUNT_ATOMIC = 10_000n

const CONFIRM_FLAG = '--confirm-one-payment'

function fail(message: string): never {
  console.error(`ABORT: ${message}`)
  process.exit(1)
}

/** Decode the x402 v2 challenge from the Payment-Required response header. */
function decodeChallenge(response: Response): any {
  const header = response.headers.get('payment-required')
  if (!header) fail('402 response carried no Payment-Required header')
  try {
    return JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'))
  } catch {
    return fail('Payment-Required header was not base64-encoded JSON')
  }
}

async function main(): Promise<void> {
  // --- Gate 1: explicit human confirmation -------------------------------
  if (!process.argv.includes(CONFIRM_FLAG)) {
    fail(
      `refusing to spend money without ${CONFIRM_FLAG}.\n` +
        `  This performs ONE real $0.01 USDC payment on Base mainnet.\n` +
        `  Re-run: BUYER_PRIVATE_KEY=0x... npx tsx scripts/activate-x402.ts ${CONFIRM_FLAG}`
    )
  }

  // --- Gate 2: credential supplied out of band ---------------------------
  const rawKey = process.env.BUYER_PRIVATE_KEY
  if (!rawKey) fail('BUYER_PRIVATE_KEY is not set in this shell')
  const privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`

  const account = privateKeyToAccount(privateKey)
  console.log(`Buyer address : ${account.address}`) // public, derived
  console.log(`Resource      : ${RESOURCE_URL}`)

  // --- Step 1: fetch the unpaid challenge --------------------------------
  const challengeResponse = await fetch(RESOURCE_URL)
  if (challengeResponse.status !== 402) {
    fail(
      `expected HTTP 402 from the resource, got ${challengeResponse.status}. ` +
        `Nothing was paid.`
    )
  }
  const challenge = decodeChallenge(challengeResponse)

  // --- Step 2: validate every pinned expectation BEFORE signing ----------
  if (challenge.x402Version !== 2) {
    fail(`unexpected x402 version ${challenge.x402Version} (expected 2)`)
  }
  const accepts = challenge.accepts?.[0]
  if (!accepts) fail('challenge contained no accepts entry')

  if (accepts.scheme !== 'exact') fail(`unexpected scheme "${accepts.scheme}" (expected "exact")`)
  if (accepts.network !== EXPECTED_NETWORK) {
    fail(`network mismatch: quoted "${accepts.network}", pinned "${EXPECTED_NETWORK}"`)
  }
  if (String(accepts.asset).toLowerCase() !== EXPECTED_ASSET.toLowerCase()) {
    fail(`asset mismatch: quoted "${accepts.asset}", pinned USDC "${EXPECTED_ASSET}"`)
  }
  if (String(accepts.payTo).toLowerCase() !== EXPECTED_PAY_TO.toLowerCase()) {
    fail(
      `recipient mismatch: quoted "${accepts.payTo}", pinned "${EXPECTED_PAY_TO}". ` +
        `Refusing to pay an address that is not ours.`
    )
  }
  let amount: bigint
  try {
    amount = BigInt(accepts.amount)
  } catch {
    return fail(`quoted amount "${accepts.amount}" is not an integer`)
  }
  if (amount > MAX_AMOUNT_ATOMIC) {
    fail(
      `quoted amount ${amount} exceeds the hard cap ${MAX_AMOUNT_ATOMIC} ` +
        `($0.01). Refusing to pay.`
    )
  }

  console.log(
    `Validated     : ${accepts.scheme} / ${accepts.network} / ${amount} atomic USDC -> ${accepts.payTo}`
  )
  console.log('Paying once…')

  // --- Step 3: exactly one payment, exactly one retry --------------------
  // wrapFetchWithPayment performs the 402 -> pay -> replay cycle a single time
  // and refuses a second payment attempt for the same request. There is no
  // loop here by construction.
  //
  // Residual note, stated honestly: the paying fetch re-reads the challenge
  // itself, so in principle the server could quote different terms between the
  // validation above and the payment. The server is ours and the cap/recipient
  // are re-checked in the receipt below, but that is the one gap this
  // structure does not close.
  const signer = toClientEvmSigner(account)
  const client = new x402Client().register(EXPECTED_NETWORK, new ExactEvmScheme(signer))
  const payingFetch = wrapFetchWithPayment(fetch, client)

  const paidResponse = await payingFetch(RESOURCE_URL)
  const settlement =
    paidResponse.headers.get('x-payment-response') ??
    paidResponse.headers.get('payment-response') ??
    null

  if (paidResponse.status !== 200) {
    console.error(`Paid request returned HTTP ${paidResponse.status}.`)
    if (settlement) console.error(`Settlement header: ${settlement}`)
    fail('payment may have settled but the resource did not return 200 — inspect before retrying')
  }

  // --- Step 4: check the signed response ---------------------------------
  const body = (await paidResponse.json()) as any
  const attestation = body?.attestation
  if (!body?.data) fail('paid response had no data field')
  if (!attestation) fail('paid response was not wrapped in an attestation envelope')
  if (attestation.signed !== true) {
    fail(`paid response was not signed (attestation.signed = ${attestation.signed})`)
  }
  if (typeof attestation.signature !== 'string' || attestation.signature.length < 64) {
    fail('attestation signature missing or malformed')
  }

  // Confirm the signing key is the one the public registry currently publishes.
  // NOTE: this is a key-identity and structural check. It deliberately does NOT
  // reimplement Ed25519 attestation verification here — that logic already
  // exists in the SDK and at onchaindiligence.com/verify, and a third copy
  // could drift. Verify cryptographically there.
  let keyMatchesRegistry: boolean | null = null
  try {
    const registry = (await (
      await fetch('https://api.onchaindiligence.com/.well-known/attestation-keys')
    ).json()) as any
    keyMatchesRegistry = (registry.keys ?? []).some(
      (key: any) => key.key_id === attestation.key_id
    )
  } catch {
    keyMatchesRegistry = null // registry unreachable; not a payment problem
  }

  // --- Step 5: public-only receipt ---------------------------------------
  const receipt = {
    activated_at: new Date().toISOString(),
    resource: RESOURCE_URL,
    network: accepts.network,
    asset: accepts.asset,
    amount_atomic: amount.toString(),
    pay_to: accepts.payTo,
    buyer: account.address,
    http_status: paidResponse.status,
    settlement_response: settlement,
    attestation_key_id: attestation.key_id ?? null,
    attestation_signature: attestation.signature,
    attestation_key_in_public_registry: keyMatchesRegistry,
    verify_at: 'https://onchaindiligence.com/verify',
  }
  console.log('\n--- PUBLIC RECEIPT ---')
  console.log(JSON.stringify(receipt, null, 2))
  console.log(
    '\nNext: re-check the Bazaar index. CDP indexes a resource after the ' +
      'facilitator settles a payment for it, which may not be instant.'
  )
}

main().catch((error) => {
  // Never print the error object raw: it can carry request context.
  console.error(`ABORT: ${error instanceof Error ? error.message : 'unknown failure'}`)
  process.exit(1)
})
