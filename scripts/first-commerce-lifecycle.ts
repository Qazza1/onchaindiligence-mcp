/**
 * first-commerce-lifecycle.ts — D2.2A: the first REAL, value-bearing OCD
 * commerce lifecycle, end to end:
 *
 *   FREE  POST /inspect/payment            (sanity-check, no money)
 *   PAID  POST /x402/preflight-payment     ($0.01 USDC on Base)
 *   PAID  GET  /x402/screen/<OCD_RECIPIENT> ($0.01 USDC on Base)
 *   FREE  POST /receipts/finalize          (capability-protected, not a payment)
 *   FREE  GET  /receipts/<preflight-id>    (public verification)
 *   FREE  GET  /receipts/<commerce-id>     (public verification)
 *          + a Bazaar discovery re-check (informational only)
 *
 * SAFETY, ALL ENFORCED BELOW BEFORE ANYTHING IS SIGNED:
 *   - DEFAULT IS DRY RUN. Real payment requires the explicit
 *     --confirm-two-payments flag; nothing is signed without it.
 *   - Exactly TWO resource URLs exist in this file, both pinned — there is
 *     no URL/recipient/amount/network argument of any kind.
 *   - Network is pinned to Base mainnet (eip155:8453), asset to USDC on
 *     Base, recipient to OCD's own configured X402_RECIPIENT_ADDRESS.
 *   - Each payment's quoted amount must be EXACTLY 10000 atomic units
 *     ($0.01) — not merely "at most" — or the script aborts before signing.
 *   - A running total is checked against a hard aggregate cap of 20000
 *     atomic units ($0.02); a third payment attempt of any kind is
 *     impossible by construction (this script calls a paying fetch exactly
 *     twice, full stop) and would in any case exceed the cap and abort.
 *   - The finalization capability returned by the paid preflight is held
 *     ONLY in a local variable: never printed, logged, written to disk, or
 *     placed in a URL. It is sent exactly once, as an Authorization: Bearer
 *     header, to POST /receipts/finalize.
 *   - The buyer private key is read from BUYER_PRIVATE_KEY only — never a
 *     CLI argument, never logged, never echoed, never written anywhere.
 *   - `wrapFetchWithPayment` performs the standard 402 -> pay -> single
 *     replay cycle per resource; there is no loop and no automatic retry
 *     beyond that one protocol-required replay.
 *
 * Usage:
 *   npx tsx scripts/first-commerce-lifecycle.ts                       (dry run; safe, no key needed)
 *   BUYER_PRIVATE_KEY=0x... npx tsx scripts/first-commerce-lifecycle.ts --confirm-two-payments
 */
import { pathToFileURL } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, erc20Abi } from 'viem'
import { base } from 'viem/chains'
import { wrapFetchWithPayment } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'
import { verifyReceiptEnvelope, fetchAttestationKeyRegistry } from '../src/receipts.js'
import {
  BASE_URL,
  NETWORK,
  ASSET,
  RECIPIENT,
  PER_CALL_ATOMIC,
  AGGREGATE_MAX_ATOMIC,
  INSPECT_URL,
  PREFLIGHT_URL,
  TARGET_SERVICE_URL,
  FINALIZE_URL,
  RECEIPTS_URL,
  EXPLORER_URL,
  BAZAAR_DISCOVERY_URL,
  LifecycleAbortError,
  resetSpendTrackerForTests,
  currentSpentAtomic,
  reserveSpend,
  targetPaymentAction,
  strictPolicy,
  decodeChallenge,
  decodeSettlementResponse,
  validateChallenge,
} from '../src/lifecycleCore.js'

// --- Pinned expectations + pre-signature safety gates now live in
// src/lifecycleCore.ts, shared verbatim with operator/src/main.ts (the
// browser-wallet operator UI, D2.2B). Re-exported here unchanged so this
// script's own CLI-only concerns (private-key buyer, dry-run gate, console
// reporting) stay in one file without duplicating the safety logic. ---------
export {
  BASE_URL,
  NETWORK,
  ASSET,
  RECIPIENT,
  PER_CALL_ATOMIC,
  AGGREGATE_MAX_ATOMIC,
  LifecycleAbortError,
  resetSpendTrackerForTests,
  reserveSpend,
  decodeChallenge,
  decodeSettlementResponse,
  validateChallenge,
}

const CONFIRM_FLAG = '--confirm-two-payments'
const DRY_RUN = !process.argv.includes(CONFIRM_FLAG)

function fail(message: string): never {
  throw new LifecycleAbortError(message)
}

/** Thin logging wrapper: validateChallenge() itself is silent (isomorphic, no console dependency) — the CLI script is the one place that wants a log line per validation. */
function validateChallengeLogged(challenge: any, label: string): bigint {
  const amount = validateChallenge(challenge, label)
  console.log(`  validated: exact/${challenge.accepts[0].network}/${amount} atomic USDC -> ${challenge.accepts[0].payTo}`)
  return amount
}

// ---------------------------------------------------------------------
// Step 1 — FREE inspection
// ---------------------------------------------------------------------
async function stepFreeInspection(): Promise<void> {
  console.log('\n=== Step 1: FREE inspect_payment ===')
  const res = await fetch(INSPECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: targetPaymentAction(), policy: strictPolicy() }),
  })
  if (res.status !== 200) fail(`inspect/payment returned HTTP ${res.status}, expected 200`)
  if (res.headers.get('payment-required')) fail('inspect/payment unexpectedly issued a payment challenge')
  const body = (await res.json()) as any
  console.log(`  decision: ${body.decision?.status}`)
  if (body.decision?.status !== 'ALLOW') {
    fail(`free inspection was not ALLOW (got ${body.decision?.status}) — refusing to proceed to any paid step`)
  }
  if (body.receipt !== null) fail('inspect/payment unexpectedly returned a non-null receipt (must always be null)')
  if (body.evidence?.external_checks_performed !== false) fail('inspect/payment unexpectedly performed external checks')
  console.log('  OK: ALLOW, no receipt, no signature, no payment.')
}

// ---------------------------------------------------------------------
// Live unpaid-challenge validation for both resources (safe in dry run)
// ---------------------------------------------------------------------
async function validatePreflightChallenge(): Promise<bigint> {
  console.log('\n=== Validating live 402 for POST /x402/preflight-payment (unpaid) ===')
  const res = await fetch(PREFLIGHT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: targetPaymentAction(), policy: strictPolicy(), publication: { preflight: true, commerce: true } }),
  })
  if (res.status !== 402) fail(`expected HTTP 402 from preflight-payment, got ${res.status}`)
  return validateChallengeLogged(decodeChallenge(res), 'preflight-payment')
}

async function validateTargetChallenge(): Promise<bigint> {
  console.log('\n=== Validating live 402 for GET /x402/screen/<recipient> (unpaid) ===')
  const res = await fetch(TARGET_SERVICE_URL)
  if (res.status !== 402) fail(`expected HTTP 402 from the target service, got ${res.status}`)
  return validateChallengeLogged(decodeChallenge(res), 'screen_wallet target service')
}

// ---------------------------------------------------------------------
// Bazaar pre/post state (informational only, free, read-only)
// ---------------------------------------------------------------------
async function checkBazaarIndex(label: string): Promise<void> {
  console.log(`\n=== Bazaar discovery check (${label}) ===`)
  const needles = ['onchaindiligence', RECIPIENT.toLowerCase()]
  let offset = 0
  const limit = 500
  let total = Infinity
  let scanned = 0
  const matches: unknown[] = []
  while (offset < total) {
    const url = `${BAZAAR_DISCOVERY_URL}?limit=${limit}&offset=${offset}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      console.log(`  Bazaar discovery unavailable (HTTP ${res.status}) — skipping, not a lifecycle blocker.`)
      return
    }
    const body = (await res.json()) as any
    const items: any[] = body.items ?? []
    total = body.pagination?.total ?? items.length
    for (const item of items) {
      const blob = JSON.stringify(item).toLowerCase()
      if (needles.some((n) => blob.includes(n))) matches.push(item)
    }
    scanned += items.length
    offset += items.length
    if (items.length === 0) break
  }
  console.log(`  scanned ${scanned}/${total} Bazaar resources; OCD matches: ${matches.length}`)
  if (matches.length === 0) {
    console.log('  NOT INDEXED: no OCD resource currently appears in Bazaar discovery.')
  } else {
    console.log('  INDEXED. Matching resource(s):')
    for (const m of matches) console.log('   ', JSON.stringify(m).slice(0, 220))
  }
}

// ---------------------------------------------------------------------
// Operator gate (dry run always ends here)
// ---------------------------------------------------------------------
function printOperatorGate(preflightAmount: bigint, targetAmount: bigint): void {
  console.log('\n' + '='.repeat(72))
  console.log('OPERATOR APPROVAL GATE — no payment has been made')
  console.log('='.repeat(72))
  console.log(`
Payment #1 — Payment Preflight
  resource  : POST ${PREFLIGHT_URL}
  amount    : ${preflightAmount} atomic units = $0.01 USDC
  network   : ${NETWORK} (Base mainnet)
  asset     : ${ASSET} (USDC)
  recipient : ${RECIPIENT} (OCD's own configured recipient)

Payment #2 — Target service (screen_wallet)
  resource  : GET ${TARGET_SERVICE_URL}
  amount    : ${targetAmount} atomic units = $0.01 USDC
  network   : ${NETWORK} (Base mainnet)
  asset     : ${ASSET} (USDC)
  recipient : ${RECIPIENT} (OCD's own configured recipient)

Aggregate hard cap: ${AGGREGATE_MAX_ATOMIC} atomic units = $0.02 USDC (enforced in code before either payment)

Buyer wallet requirements:
  - a DEDICATED low-balance buyer wallet, not the operational treasury
  - USDC: at least 0.02 USDC (covers both $0.01 payments exactly, no margin needed
    beyond what covers the two exact quoted amounts)
  - ETH on Base: a small amount for gas if the buyer's payment authorization
    requires an on-chain transaction/approval step; fund only the minimum needed
  - BUYER_PRIVATE_KEY must be set as an environment variable only — never a
    CLI argument, never committed, never echoed

Exact command to execute (after explicit operator approval):
  BUYER_PRIVATE_KEY=0x... npx tsx scripts/first-commerce-lifecycle.ts ${CONFIRM_FLAG}
`)
  console.log('This was a DRY RUN. NO PAYMENT WAS EXECUTED.')
  console.log('Waiting for explicit operator approval before any real payment runs.')
}

// ---------------------------------------------------------------------
// Real execution (only reached with --confirm-two-payments)
// ---------------------------------------------------------------------
async function runReal(): Promise<void> {
  const rawKey = process.env.BUYER_PRIVATE_KEY
  if (!rawKey) fail('BUYER_PRIVATE_KEY is not set in this shell')
  const privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`
  const account = privateKeyToAccount(privateKey)
  console.log(`\nBuyer address: ${account.address} (public, derived from the key — the key itself is never printed)`)

  // Public balance check only — no secret material involved.
  try {
    const client = createPublicClient({ chain: base, transport: http() })
    const [usdc, ethBalance] = await Promise.all([
      client.readContract({ address: ASSET as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      client.getBalance({ address: account.address }),
    ])
    console.log(`Buyer USDC balance: ${usdc} atomic units (need >= ${AGGREGATE_MAX_ATOMIC})`)
    console.log(`Buyer ETH balance : ${ethBalance} wei`)
    if ((usdc as bigint) < AGGREGATE_MAX_ATOMIC) {
      fail(`buyer USDC balance ${usdc} is below the ${AGGREGATE_MAX_ATOMIC} atomic units needed for both payments`)
    }
  } catch (err: any) {
    fail(`could not verify buyer balance before spending: ${err?.message || err}`)
  }

  const signer = toClientEvmSigner(account)
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer))
  const payingFetch = wrapFetchWithPayment(fetch, client)

  // --- Payment #1: preflight ------------------------------------------
  console.log('\n=== Step 2: PAID preflight ($0.01) ===')
  const preflightBody = JSON.stringify({ action: targetPaymentAction(), policy: strictPolicy(), publication: { preflight: true, commerce: true } })
  const preflightChallengeRes = await fetch(PREFLIGHT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: preflightBody })
  if (preflightChallengeRes.status !== 402) fail(`expected 402 from preflight-payment, got ${preflightChallengeRes.status}`)
  const preflightAmount = validateChallengeLogged(decodeChallenge(preflightChallengeRes), 'preflight-payment')
  reserveSpend(preflightAmount, 'preflight-payment')

  const paidPreflightRes = await payingFetch(PREFLIGHT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: preflightBody })
  if (paidPreflightRes.status !== 200) fail(`paid preflight-payment returned HTTP ${paidPreflightRes.status}`)
  const preflightResult = (await paidPreflightRes.json()) as any

  if (preflightResult.decision?.status !== 'ALLOW') fail(`preflight decision was not ALLOW (${preflightResult.decision?.status})`)
  const preflightReceipt = preflightResult.receipt?.receipt
  if (preflightReceipt?.receipt_type !== 'PREFLIGHT') fail('receipt_type was not PREFLIGHT')
  if (preflightReceipt?.execution?.status !== 'NOT_SUBMITTED') fail('preflight execution status was not NOT_SUBMITTED')
  if (preflightReceipt?.settlement?.status !== 'NOT_APPLICABLE') fail('preflight settlement status was not NOT_APPLICABLE')

  const registry = await fetchAttestationKeyRegistry()
  const preflightVerification = verifyReceiptEnvelope(preflightResult.receipt, registry)
  if (preflightVerification.state !== 'VALID') {
    fail(`PREFLIGHT receipt did not independently verify VALID (${preflightVerification.state}: ${preflightVerification.code})`)
  }
  console.log(`  PREFLIGHT receipt: ${preflightReceipt.receipt_id} — proof VALID, decision ALLOW`)

  const capability: string = preflightResult.finalization?.capability
  const capabilityExpiresAt: string = preflightResult.finalization?.expires_at
  if (!capability) fail('no finalization capability was returned')
  if (!capabilityExpiresAt) fail('no finalization capability expiry was returned')
  console.log(`  finalization capability received (kept in memory only), expires ${capabilityExpiresAt}`)

  // --- Payment #2: target service -------------------------------------
  console.log('\n=== Step 3: PAID target service ($0.01) ===')
  const targetChallengeRes = await fetch(TARGET_SERVICE_URL)
  if (targetChallengeRes.status !== 402) fail(`expected 402 from the target service, got ${targetChallengeRes.status}`)
  const targetAmount = validateChallengeLogged(decodeChallenge(targetChallengeRes), 'screen_wallet target service')
  reserveSpend(targetAmount, 'screen_wallet target service')

  const paidTargetRes = await payingFetch(TARGET_SERVICE_URL)
  if (paidTargetRes.status !== 200) fail(`paid target service call returned HTTP ${paidTargetRes.status}`)
  const settlementHeader = paidTargetRes.headers.get('x-payment-response') ?? paidTargetRes.headers.get('payment-response')
  if (!settlementHeader) fail('paid target service response carried no payment-response header')
  const settlement = decodeSettlementResponse(settlementHeader)
  if (!settlement.success) fail('target service payment-response reported success=false')
  console.log(`  settlement response network field: ${JSON.stringify(settlement.network)} (informational; not the safety gate — validateChallenge() already confirmed ${NETWORK} before signing)`)
  const targetBody = (await paidTargetRes.json()) as any
  if (targetBody?.attestation?.signed !== true) fail('paid target service response was not signed')
  console.log(`  transaction hash: ${settlement.transaction}`)
  console.log(`  service result  : sanctioned=${targetBody?.data?.sanctioned}`)

  console.log(`\nTotal spent this run: ${currentSpentAtomic()} atomic units (cap ${AGGREGATE_MAX_ATOMIC})`)

  // --- Step 4: finalization (free) -------------------------------------
  console.log('\n=== Step 4: FREE finalization ===')
  const finalizeRes = await fetch(FINALIZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
    body: JSON.stringify({ transaction_hash: settlement.transaction, execution_provider: 'x402', provider_reference: null, result_digest: null }),
  })
  if (finalizeRes.status !== 200) {
    fail(`finalization returned HTTP ${finalizeRes.status}: ${await finalizeRes.text().catch(() => '')}`)
  }
  const commerceEnvelope = (await finalizeRes.json()) as any
  const commerceReceipt = commerceEnvelope.receipt

  if (commerceReceipt.receipt_type !== 'COMMERCE') fail('finalized receipt_type was not COMMERCE')
  if (commerceReceipt.links?.preflight_receipt_id !== preflightReceipt.receipt_id) fail('Commerce Receipt does not reference the preflight receipt')
  if (commerceReceipt.decision?.status !== 'ALLOW') fail(`Commerce Receipt decision was not ALLOW (${commerceReceipt.decision?.status})`)
  if (commerceReceipt.execution?.status !== 'CONFIRMED') fail(`Commerce Receipt execution was not CONFIRMED (${commerceReceipt.execution?.status})`)
  if (commerceReceipt.settlement?.status !== 'CONFIRMED') fail(`Commerce Receipt settlement was not CONFIRMED (${commerceReceipt.settlement?.status})`)
  const commerceVerification = verifyReceiptEnvelope(commerceEnvelope, registry)
  if (commerceVerification.state !== 'VALID') {
    fail(`COMMERCE receipt did not independently verify VALID (${commerceVerification.state}: ${commerceVerification.code})`)
  }
  console.log(`  COMMERCE receipt: ${commerceReceipt.receipt_id} — proof VALID, execution CONFIRMED, settlement CONFIRMED`)
  for (const check of commerceReceipt.checks ?? []) {
    console.log(`    ${check.result === 'PASS' ? 'PASS' : check.result} — ${check.id}`)
  }

  // --- Step 5: public resolution ----------------------------------------
  console.log('\n=== Step 5: public resolution ===')
  const preflightPublic = await fetch(RECEIPTS_URL(preflightReceipt.receipt_id))
  console.log(`  GET /receipts/${preflightReceipt.receipt_id} -> HTTP ${preflightPublic.status}`)
  const commercePublic = await fetch(RECEIPTS_URL(commerceReceipt.receipt_id))
  console.log(`  GET /receipts/${commerceReceipt.receipt_id} -> HTTP ${commercePublic.status}`)
  console.log(`\n  Receipt Explorer (verify manually / via browser):`)
  console.log(`    ${EXPLORER_URL(preflightReceipt.receipt_id)}`)
  console.log(`    ${EXPLORER_URL(commerceReceipt.receipt_id)}`)

  // --- Step 6: Bazaar re-check (informational) ---------------------------
  await checkBazaarIndex('post-execution')

  console.log('\n' + '='.repeat(72))
  console.log('LIFECYCLE COMPLETE')
  console.log(`PREFLIGHT receipt: ${preflightReceipt.receipt_id}`)
  console.log(`COMMERCE  receipt: ${commerceReceipt.receipt_id}`)
  console.log(`Total spent: $${(Number(currentSpentAtomic()) / 1_000_000).toFixed(2)} USDC`)
  console.log('='.repeat(72))
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? 'MODE: DRY RUN (no payment will be made)' : 'MODE: LIVE — real payments will be made')

  await stepFreeInspection()
  const preflightAmount = await validatePreflightChallenge()
  const targetAmount = await validateTargetChallenge()
  await checkBazaarIndex('pre-execution')

  if (DRY_RUN) {
    printOperatorGate(preflightAmount, targetAmount)
    return
  }

  await runReal()
}

// Only run when executed directly (`tsx scripts/first-commerce-lifecycle.ts`),
// never as a side effect of a test file importing this module's exported
// pure functions (validateChallenge, reserveSpend, etc.) for unit testing.
// pathToFileURL handles Windows drive-letter / separator differences that a
// hand-rolled `file://${...}` string does not.
const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`ABORT: ${error instanceof Error ? error.message : 'unknown failure'}`)
    process.exit(1)
  })
}
