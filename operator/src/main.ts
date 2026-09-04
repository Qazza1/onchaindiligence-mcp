/**
 * main.ts — D2.2B operator commerce UI, browser side.
 *
 * Bundled by esbuild into operator/dist/app.js and loaded by operator/index.html.
 * LOCAL ONLY: served exclusively by operator/server.ts on localhost, never
 * deployed. All requests to the live OCD API go through this same local
 * server's /proxy/* passthrough (same-origin from the browser's point of
 * view — no CORS change to the production API was needed or made).
 *
 * SECURITY: the finalization capability is held ONLY in the module-level
 * `capability` variable below. It is never assigned to localStorage,
 * sessionStorage, IndexedDB, a URL, a DOM attribute, or any console.log /
 * log() call — grep this file for "capability" to confirm before editing.
 */
import { createWalletClient, createPublicClient, custom, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { wrapFetchWithPayment } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import type { ClientEvmSigner } from '@x402/evm'
import {
  NETWORK,
  ASSET,
  RECIPIENT,
  AGGREGATE_MAX_ATOMIC,
  LifecycleAbortError,
  reserveSpend,
  targetPaymentAction,
  strictPolicy,
  decodeChallenge,
  decodeSettlementResponse,
  validateChallenge,
} from '../../src/lifecycleCore.js'
import { canExecuteLifecycle, canRetryTargetStep, type InspectionStatus, type TargetStepFailurePoint } from './gating.js'
import { extractSafe402Detail } from './safeError.js'
import { attemptFinalize, type FinalizeCapabilityHolder, type FinalizeAttemptOutcome } from './finalizeClient.js'

// --- local proxy paths (same origin as this page — see operator/server.ts) --
const PROXY_INSPECT = '/proxy/inspect/payment'
const PROXY_PREFLIGHT = '/proxy/x402/preflight-payment'
const PROXY_TARGET = `/proxy/x402/screen/${RECIPIENT}`
const PROXY_FINALIZE = '/proxy/receipts/finalize'
const proxyReceipt = (id: string) => `/proxy/receipts/${id}`
const explorerUrl = (id: string) => `https://onchaindiligence.com/r/${id}`
const baseExplorerTx = (hash: string) => `https://basescan.org/tx/${hash}`

// --- DOM ---------------------------------------------------------------
const $ = (id: string) => document.getElementById(id) as HTMLElement
const logEl = $('log')
function logLine(msg: string): void {
  const line = document.createElement('div')
  line.textContent = msg
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

// --- mutable UI state ----------------------------------------------------
let account: `0x${string}` | null = null
let chainId: number | null = null
let usdcBalanceAtomic: bigint | null = null
let inspectionStatus: InspectionStatus = 'idle'
let confirmed = false
let targetStepFailurePoint: TargetStepFailurePoint = null

// Finalization capability — IN MEMORY ONLY. Never persisted, never logged,
// never rendered. See file header.
let capability: string | null = null

const publicClient = createPublicClient({ chain: base, transport: http() })

function renderGate(): void {
  const verdict = canExecuteLifecycle({ walletConnected: account !== null, chainId, inspectionStatus, confirmed, usdcBalanceAtomic })
  const btn = $('btn-execute') as HTMLButtonElement
  btn.disabled = !verdict.allowed
  const reasonsEl = $('gate-reasons')
  reasonsEl.innerHTML = ''
  for (const reason of verdict.reasons) {
    const li = document.createElement('li')
    li.textContent = reason
    reasonsEl.appendChild(li)
  }
}

// --- wallet ---------------------------------------------------------------
function getInjectedProvider(): any {
  const eth = (window as any).ethereum
  if (!eth) throw new Error('No injected EVM wallet found (MetaMask / Rabby / Coinbase Wallet).')
  return eth
}

async function refreshChain(): Promise<void> {
  const eth = getInjectedProvider()
  const hex: string = await eth.request({ method: 'eth_chainId' })
  chainId = parseInt(hex, 16)
  $('wallet-chain').textContent = chainId === base.id ? 'Base mainnet' : `chain ${chainId} (NOT Base)`
  ;($('btn-switch') as HTMLButtonElement).style.display = chainId === base.id ? 'none' : 'inline-block'
  renderGate()
}

async function refreshBalances(): Promise<void> {
  if (!account) return
  const [usdc, ethBal] = await Promise.all([
    publicClient.readContract({ address: ASSET as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    publicClient.getBalance({ address: account }),
  ])
  usdcBalanceAtomic = usdc as bigint
  $('bal-usdc').textContent = `${formatUnits(usdcBalanceAtomic, 6)} USDC (${usdcBalanceAtomic} atomic)`
  $('bal-eth').textContent = `${formatUnits(ethBal, 18)} ETH`
  renderGate()
}

async function connectWallet(): Promise<void> {
  try {
    const eth = getInjectedProvider()
    const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' })
    if (!accounts[0]) throw new Error('wallet returned no account')
    account = accounts[0] as `0x${string}`
    $('wallet-status').textContent = 'connected'
    $('wallet-address').textContent = account
    logLine(`Wallet connected: ${account}`)
    eth.on?.('accountsChanged', (accts: string[]) => {
      account = (accts[0] as `0x${string}`) ?? null
      $('wallet-address').textContent = account ?? '—'
      renderGate()
    })
    eth.on?.('chainChanged', () => refreshChain())
    await refreshChain()
    await refreshBalances()
  } catch (err: any) {
    logLine(`Wallet connect failed: ${err?.message ?? err}`)
  }
  renderGate()
}

async function switchToBase(): Promise<void> {
  const eth = getInjectedProvider()
  const hexChainId = `0x${base.id.toString(16)}`
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] })
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexChainId,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          },
        ],
      })
    } else {
      logLine(`Switch to Base failed: ${err?.message ?? err}`)
      return
    }
  }
  await refreshChain()
  await refreshBalances()
}

// --- x402 client, built once the wallet is connected -----------------------
function buildPayingFetch() {
  if (!account) throw new Error('wallet not connected')
  const eth = getInjectedProvider()
  const walletClient = createWalletClient({ chain: base, transport: custom(eth), account })
  const signer: ClientEvmSigner = {
    address: account,
    async signTypedData(message) {
      return walletClient.signTypedData({
        account: account as `0x${string}`,
        domain: message.domain as any,
        types: message.types as any,
        primaryType: message.primaryType,
        message: message.message as any,
      })
    },
  }
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer))
  return wrapFetchWithPayment(fetch, client)
}

// --- free inspection --------------------------------------------------------
async function runInspection(): Promise<void> {
  inspectionStatus = 'pending'
  $('inspect-result').innerHTML = '<span class="pill wait">checking…</span>'
  renderGate()
  try {
    const res = await fetch(PROXY_INSPECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: targetPaymentAction(), policy: strictPolicy() }),
    })
    if (res.status !== 200) throw new Error(`inspect/payment returned HTTP ${res.status}`)
    const body = await res.json()
    if (body.decision?.status === 'ALLOW' && body.receipt === null) {
      inspectionStatus = 'ALLOW'
      $('inspect-result').innerHTML = '<span class="pill ok">ALLOW</span>'
      logLine('Free inspection: ALLOW')
    } else {
      inspectionStatus = 'BLOCKED'
      $('inspect-result').innerHTML = `<span class="pill bad">${body.decision?.status ?? 'BLOCKED'}</span>`
      logLine(`Free inspection did not return ALLOW: ${body.decision?.status}`)
    }
  } catch (err: any) {
    inspectionStatus = 'ERROR'
    $('inspect-result').innerHTML = '<span class="pill bad">ERROR</span>'
    logLine(`Free inspection failed: ${err?.message ?? err}`)
  }
  renderGate()
}

// --- server-side receipt verification (node:crypto lives in the local server, not the browser bundle) ---
async function verifyReceiptViaLocalServer(envelope: unknown): Promise<{ state: string; code: string; message: string }> {
  const res = await fetch('/local/verify-receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  return res.json()
}

/**
 * Only called for a paid replay that unexpectedly stayed 402 (e.g. the
 * facilitator's /verify rejecting the request after the wallet already
 * signed). Parses the body defensively and delegates to the allowlisted
 * extractor in safeError.ts — never logs/displays the raw body, headers, or
 * anything payment-signature-shaped.
 */
async function safe402Message(res: Response, routeLabel: string): Promise<string> {
  let body: unknown = null
  try {
    body = await res.clone().json()
  } catch {
    body = null
  }
  return extractSafe402Detail(body, routeLabel)
}

function showRecovery(message: string, allowRetry: boolean): void {
  const section = $('recovery')
  section.style.display = 'block'
  $('recovery-message').textContent = message
  const retryBtn = $('btn-retry-target') as HTMLButtonElement
  retryBtn.style.display = allowRetry ? 'inline-block' : 'none'
}

// --- the lifecycle itself ----------------------------------------------------
let preflightReceiptId: string | null = null

async function runPreflightStep(): Promise<void> {
  logLine('\n=== Payment #1: Payment Preflight ($0.01) ===')
  const body = JSON.stringify({
    action: targetPaymentAction(),
    policy: strictPolicy(),
    publication: { preflight: true, commerce: true },
  })
  const challengeRes = await fetch(PROXY_PREFLIGHT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (challengeRes.status !== 402) throw new LifecycleAbortError(`expected 402 from preflight-payment, got ${challengeRes.status}`)
  const amount = validateChallenge(decodeChallenge(challengeRes), 'preflight-payment')
  logLine(`  challenge validated: exact ${amount} atomic USDC on ${NETWORK} -> ${RECIPIENT}`)
  reserveSpend(amount, 'preflight-payment')

  const payingFetch = buildPayingFetch()
  logLine('  awaiting wallet signature for payment #1…')
  const paidRes = await payingFetch(PROXY_PREFLIGHT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (paidRes.status !== 200) {
    const detail = paidRes.status === 402 ? await safe402Message(paidRes, 'preflight-payment') : `HTTP ${paidRes.status}`
    throw new LifecycleAbortError(`paid preflight-payment rejected — ${detail}`)
  }
  const result = await paidRes.json()

  if (result.decision?.status !== 'ALLOW') throw new LifecycleAbortError(`preflight decision was not ALLOW (${result.decision?.status})`)
  const receipt = result.receipt?.receipt
  if (receipt?.receipt_type !== 'PREFLIGHT') throw new LifecycleAbortError('receipt_type was not PREFLIGHT')
  if (receipt?.execution?.status !== 'NOT_SUBMITTED') throw new LifecycleAbortError('preflight execution status was not NOT_SUBMITTED')
  if (receipt?.settlement?.status !== 'NOT_APPLICABLE') throw new LifecycleAbortError('preflight settlement status was not NOT_APPLICABLE')

  const verification = await verifyReceiptViaLocalServer(result.receipt)
  if (verification.state !== 'VALID') {
    throw new LifecycleAbortError(`PREFLIGHT receipt did not independently verify VALID (${verification.state}: ${verification.code})`)
  }
  logLine(`  PREFLIGHT receipt ${receipt.receipt_id} — proof VALID, decision ALLOW`)

  const cap: string | undefined = result.finalization?.capability
  const expiresAt: string | undefined = result.finalization?.expires_at
  if (!cap) throw new LifecycleAbortError('no finalization capability was returned')
  if (!expiresAt) throw new LifecycleAbortError('no finalization capability expiry was returned')
  capability = cap
  preflightReceiptId = receipt.receipt_id
  logLine(`  finalization capability received (kept in memory only), expires ${expiresAt}`)

  $('result-preflight-id').textContent = receipt.receipt_id
  ;($('result-preflight-link') as HTMLAnchorElement).href = explorerUrl(receipt.receipt_id)
}

async function runTargetStep(): Promise<{ transactionHash: string }> {
  logLine('\n=== Payment #2: screen_wallet ($0.01) ===')
  targetStepFailurePoint = 'before-signature-requested'

  const challengeRes = await fetch(PROXY_TARGET)
  if (challengeRes.status !== 402) throw new LifecycleAbortError(`expected 402 from the target service, got ${challengeRes.status}`)
  const amount = validateChallenge(decodeChallenge(challengeRes), 'screen_wallet target service')
  logLine(`  challenge validated: exact ${amount} atomic USDC on ${NETWORK} -> ${RECIPIENT}`)

  reserveSpend(amount, 'screen_wallet target service')
  targetStepFailurePoint = 'after-signature-requested'

  const payingFetch = buildPayingFetch()
  logLine('  awaiting wallet signature for payment #2…')
  const paidRes = await payingFetch(PROXY_TARGET)
  if (paidRes.status !== 200) {
    const detail = paidRes.status === 402 ? await safe402Message(paidRes, 'screen_wallet target service') : `HTTP ${paidRes.status}`
    throw new LifecycleAbortError(`paid target service call rejected — ${detail}`)
  }
  const settlementHeader = paidRes.headers.get('x-payment-response') ?? paidRes.headers.get('payment-response')
  if (!settlementHeader) throw new LifecycleAbortError('paid target service response carried no payment-response header')
  const settlement = decodeSettlementResponse(settlementHeader)
  if (!settlement.success) throw new LifecycleAbortError('target service payment-response reported success=false')
  logLine(`  transaction hash: ${settlement.transaction}`)
  targetStepFailurePoint = null
  return { transactionHash: settlement.transaction }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** D2.2B2: bounded, clearly-logged auto-retry for the FREE finalize request only. Never applies to any paid step. */
const MAX_AUTO_FINALIZE_RETRIES = 3

// The capability-holder seam finalizeClient.ts requires. `get`/`clear` only
// ever touch the one module-level `capability` variable above — this object
// is not a second place capability lives, just an interface adapter.
const capabilityHolder: FinalizeCapabilityHolder = {
  get: () => capability,
  clear: () => {
    capability = null
  },
}

async function postFinalize(transactionHash: string, cap: string): Promise<Response> {
  return fetch(PROXY_FINALIZE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cap}` },
    body: JSON.stringify({ transaction_hash: transactionHash, execution_provider: 'x402' }),
  })
}

/**
 * DOM-aware wrapper around finalizeClient.ts's pure attemptFinalize(): does
 * exactly one POST /receipts/finalize for the given (already-settled) tx
 * hash, then renders the outcome. See finalizeClient.ts's header for the
 * capability-handling guarantee (cleared only on a definitive outcome) and
 * for why this can never call payingFetch or touch a wallet.
 */
async function attemptFinalizeAndRender(transactionHash: string): Promise<FinalizeAttemptOutcome> {
  const outcome = await attemptFinalize(transactionHash, preflightReceiptId ?? '', capabilityHolder, {
    postFinalize,
    verifyReceipt: verifyReceiptViaLocalServer,
  })
  if (outcome.kind !== 'done') return outcome

  const receipt = outcome.envelope.receipt
  logLine(`  COMMERCE receipt ${receipt.receipt_id} — proof VALID, execution CONFIRMED, settlement CONFIRMED`)
  $('result-commerce-id').textContent = receipt.receipt_id
  ;($('result-commerce-link') as HTMLAnchorElement).href = explorerUrl(receipt.receipt_id)
  $('result-tx').textContent = transactionHash
  ;($('result-tx-link') as HTMLAnchorElement).href = baseExplorerTx(transactionHash)

  // Public resolution — through the same local proxy (production CORS on
  // /receipts/:id only allows https://onchaindiligence.com; the proxy avoids
  // needing a CORS change for this local tool).
  const preflightPublic = await fetch(proxyReceipt(preflightReceiptId as string))
  const commercePublic = await fetch(proxyReceipt(receipt.receipt_id))
  logLine(`  GET /receipts/${preflightReceiptId} -> HTTP ${preflightPublic.status}`)
  logLine(`  GET /receipts/${receipt.receipt_id} -> HTTP ${commercePublic.status}`)

  $('result').style.display = 'block'
  logLine('\nLIFECYCLE COMPLETE')
  return outcome
}

let pendingFinalizeTransactionHash: string | null = null

function showFinalizeRecovery(message: string): void {
  const section = $('finalize-recovery')
  section.style.display = 'block'
  $('finalize-recovery-message').textContent = message
}

function hideFinalizeRecovery(): void {
  $('finalize-recovery').style.display = 'none'
}

async function runFinalizeStep(transactionHash: string): Promise<void> {
  logLine('\n=== Finalization (free) ===')
  for (let attempt = 1; attempt <= MAX_AUTO_FINALIZE_RETRIES; attempt++) {
    const outcome = await attemptFinalizeAndRender(transactionHash)
    if (outcome.kind === 'done') {
      hideFinalizeRecovery()
      return
    }
    if (outcome.kind === 'failed') throw new LifecycleAbortError(outcome.message)
    // pending -- bounded, clearly-logged automatic retry of the FREE finalize
    // request only (never a payment). Capability remains in memory.
    logLine(`  finalization pending (${outcome.reason}): ${outcome.message}`)
    if (attempt < MAX_AUTO_FINALIZE_RETRIES) {
      logLine(`  Payment settled. Waiting for independent chain confirmation. Auto-retry ${attempt}/${MAX_AUTO_FINALIZE_RETRIES} in ${outcome.retryAfterSeconds}s…`)
      await sleep(outcome.retryAfterSeconds * 1000)
    } else {
      pendingFinalizeTransactionHash = transactionHash
      showFinalizeRecovery(
        `Payment settled. Waiting for independent chain confirmation. (${outcome.reason}: ${outcome.message}) ` +
          'The finalization capability remains in memory. Click "Retry finalization" once you expect the chain state to have caught up — do not refresh this page.'
      )
      return
    }
  }
}

async function retryFinalization(): Promise<void> {
  if (!pendingFinalizeTransactionHash) return
  const outcome = await attemptFinalizeAndRender(pendingFinalizeTransactionHash)
  if (outcome.kind === 'done') {
    pendingFinalizeTransactionHash = null
    hideFinalizeRecovery()
    return
  }
  if (outcome.kind === 'failed') {
    pendingFinalizeTransactionHash = null
    hideFinalizeRecovery()
    logLine(`ABORT during finalization retry: ${outcome.message}`)
    return
  }
  logLine(`  finalization still pending (${outcome.reason}): ${outcome.message}`)
  showFinalizeRecovery(
    `Still waiting for independent chain confirmation. (${outcome.reason}: ${outcome.message}) The finalization capability remains in memory.`
  )
}

async function executeLifecycle(): Promise<void> {
  const btn = $('btn-execute') as HTMLButtonElement
  btn.disabled = true
  $('recovery').style.display = 'none'
  hideFinalizeRecovery()
  try {
    await runPreflightStep()
  } catch (err: any) {
    logLine(`ABORT before any payment #2 attempt: ${err?.message ?? err}`)
    renderGate()
    return
  }

  let transactionHash: string
  try {
    ;({ transactionHash } = await runTargetStep())
  } catch (err: any) {
    const safeToRetry = canRetryTargetStep(targetStepFailurePoint)
    if (safeToRetry) {
      showRecovery(
        `Preflight payment succeeded (receipt ${preflightReceiptId}). Payment #2 failed before any wallet signature was requested for it, so it is safe to retry: ${err?.message ?? err}`,
        true
      )
    } else {
      showRecovery(
        `Preflight payment succeeded (receipt ${preflightReceiptId}). Do not restart blindly: payment #2 failed AFTER a wallet signature may have been requested/submitted, so it is uncertain whether a settlement occurred. This requires manual review before any further action. Error: ${err?.message ?? err}`,
        false
      )
    }
    logLine(`ABORT during payment #2: ${err?.message ?? err}`)
    return
  }

  try {
    await runFinalizeStep(transactionHash)
  } catch (err: any) {
    showRecovery(
      `Both payments settled (tx ${transactionHash}) but finalization failed. The transaction hash above is safe to finalize manually once the issue is understood — do not attempt a third payment. Error: ${err?.message ?? err}`,
      false
    )
    logLine(`ABORT during finalization: ${err?.message ?? err}`)
  }
}

async function retryTargetStep(): Promise<void> {
  $('recovery').style.display = 'none'
  hideFinalizeRecovery()
  try {
    const { transactionHash } = await runTargetStep()
    await runFinalizeStep(transactionHash)
  } catch (err: any) {
    const safeToRetry = canRetryTargetStep(targetStepFailurePoint)
    showRecovery(`Retry failed: ${err?.message ?? err}`, safeToRetry)
    logLine(`ABORT during target-step retry: ${err?.message ?? err}`)
  }
}

// --- wire up ----------------------------------------------------------------
$('btn-connect').addEventListener('click', () => void connectWallet())
$('btn-switch').addEventListener('click', () => void switchToBase())
$('btn-inspect').addEventListener('click', () => void runInspection())
$('btn-execute').addEventListener('click', () => void executeLifecycle())
$('btn-retry-target').addEventListener('click', () => void retryTargetStep())
$('btn-retry-finalize').addEventListener('click', () => void retryFinalization())
;($('confirm-checkbox') as HTMLInputElement).addEventListener('change', (e) => {
  confirmed = (e.target as HTMLInputElement).checked
  renderGate()
})

logLine(`Pinned aggregate cap: ${AGGREGATE_MAX_ATOMIC} atomic units ($0.02 USDC). Two payments, no more, by construction.`)
renderGate()
