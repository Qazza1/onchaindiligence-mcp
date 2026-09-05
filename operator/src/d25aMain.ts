/**
 * d25aMain.ts — D2.5A: drives the REAL @onchaindiligence/sdk/commerce
 * client against production OCD and the real OneSource merchant, using an
 * injected EIP-1193 wallet for both real payments (OCD preflight fee,
 * OneSource merchant payment). LOCAL ONLY -- never deployed.
 *
 * Architecture:
 *   - This browser bundle imports @onchaindiligence/sdk/commerce directly
 *     (the browser-safe barrel) and runs the ENTIRE CommerceOperation
 *     lifecycle (open/preflight/execute/observe/finalize) here, because
 *     execute() must call the wallet directly and only the browser has
 *     window.ethereum.
 *   - The durable recovery store (HttpRecoveryStore) is a thin RPC client
 *     to THIS local server's /local/recovery/* endpoints, backed by the
 *     SDK's own NodeFileRecoveryStore running server-side.
 *   - `createCommerceClient({ endpoint: '' })` talks to THIS local server's
 *     own mirrored paths (operator/server.ts), same-origin, avoiding CORS
 *     against both mcp.onchaindiligence.com and api.onesource.io.
 *   - TWO client instances share the SAME durable recovery record:
 *     `discoveryClient` (plain fetch) is used to open the operation and
 *     read live prices -- nothing it does can ever trigger a wallet
 *     prompt. `payingClient` (fetch wrapped with wrapFetchWithPayment) is
 *     built ONLY inside the "Authorize & run lifecycle" click handler and
 *     is what actually pays -- see runFullLifecycle().
 *
 * ONE real merchant payment, ever, per operation -- see
 * OneSourceViaLocalProxyExecutor and the single btn-execute handler below.
 */
import { createWalletClient, createPublicClient, custom, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { wrapFetchWithPayment } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { decodeChallenge } from '../../src/lifecycleCore.js'
import {
  createCommerceClient,
  X402BaseUsdcExecutor,
  fixedRecipientPolicy,
  buildEvidenceExport,
  BASE_NETWORK,
  BASE_USDC,
  type ClientEvmSigner,
  type CommerceOperation,
  type CommerceAction,
  type CommercePolicy,
  type PrepareContext,
  type PrepareResult,
  type ExecutionResult,
  type CommerceExecutor,
} from '@onchaindiligence/sdk/commerce'
import { HttpRecoveryStore } from './httpRecoveryStore.js'

const ONESOURCE_TRUE_RESOURCE = 'https://api.onesource.io/api/chain/block-number'
const ONESOURCE_LOCAL_PROXY = '/proxy/onesource/block-number'
const OPERATION_STORAGE_KEY = 'd25a-active-operation-id' // NOT a secret -- D2.4: "operation_id alone grants no access". Only a convenience pointer for this page's own reload.

// --- DOM ---------------------------------------------------------------
const $ = (id: string) => document.getElementById(id) as HTMLElement
const logEl = $('log')
function logLine(msg: string): void {
  const line = document.createElement('div')
  line.textContent = msg
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

function explorerUrl(id: string): string {
  return `https://onchaindiligence.com/r/${id}`
}
function baseExplorerTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`
}

// --- wallet (adapted from operator/src/main.ts's proven pattern) ----------
let account: `0x${string}` | null = null
let chainId: number | null = null
const publicClient = createPublicClient({ chain: base, transport: http() })

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
    publicClient.readContract({ address: BASE_USDC as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    publicClient.getBalance({ address: account }),
  ])
  $('bal-usdc').textContent = `${formatUnits(usdc as bigint, 6)} USDC (${usdc} atomic)`
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
        params: [{ chainId: hexChainId, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }],
      })
    } else {
      logLine(`Switch to Base failed: ${err?.message ?? err}`)
      return
    }
  }
  await refreshChain()
  await refreshBalances()
}

function buildInjectedSigner(): ClientEvmSigner {
  if (!account) throw new Error('wallet not connected')
  const eth = getInjectedProvider()
  const walletClient = createWalletClient({ chain: base, transport: custom(eth), account })
  return {
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
}

/** Same pattern as operator/src/main.ts's buildPayingFetch(): a fetch that pays automatically ONLY when it actually receives a 402, using the wallet's own signature. Every other response passes through unchanged. */
function buildPayingFetch(): typeof globalThis.fetch {
  const signer = buildInjectedSigner()
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(signer))
  return wrapFetchWithPayment(fetch, client)
}

// --- OneSource executor: real X402BaseUsdcExecutor, with the ACTUAL fetch
// substituted to go through this local server's same-origin proxy (CORS --
// api.onesource.io does not grant this page's origin cross-origin access).
// action.resource sent to OCD stays the TRUE external URL for truthful
// evidence; only the executor's own network calls are redirected. ----------
class OneSourceViaLocalProxyExecutor implements CommerceExecutor {
  readonly id: string
  readonly version: string
  readonly recoveryMode: CommerceExecutor['recoveryMode']
  private readonly inner: X402BaseUsdcExecutor

  constructor(inner: X402BaseUsdcExecutor) {
    this.inner = inner
    this.id = inner.id
    this.version = inner.version
    this.recoveryMode = inner.recoveryMode
  }

  private localize(context: PrepareContext): PrepareContext {
    return { ...context, action: { ...context.action, resource: ONESOURCE_LOCAL_PROXY } }
  }

  async prepare(context: PrepareContext): Promise<PrepareResult> {
    return this.inner.prepare(this.localize(context))
  }
  async submit(prepared: PrepareResult): Promise<ExecutionResult> {
    return this.inner.submit(prepared)
  }
  async resume(prepared: PrepareResult, prior?: ExecutionResult): Promise<ExecutionResult> {
    return this.inner.resume(prepared, prior)
  }
}

// --- live challenge probing (Section 1: re-qualify fresh, never assume) ---
// These are PLAIN, read-only fetches -- never routed through a payment-
// wrapped fetch -- so reading a price can never itself trigger a wallet
// prompt or a payment, no matter what else this page has constructed.

interface LiveChallenge {
  network: string
  asset: string
  recipient: string
  atomicAmount: string
  decimalAmount: string
}

function atomicToDecimal6(atomic: string): string {
  const n = BigInt(atomic)
  const whole = n / 1_000_000n
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

function challengeFromResponse(res: Response, label: string): LiveChallenge {
  const challenge = decodeChallenge(res)
  const accepts = (challenge.accepts as any[])?.find((a) => a.scheme === 'exact')
  if (!accepts) throw new Error(`${label}: challenge carried no "exact" scheme option`)
  return { network: accepts.network, asset: accepts.asset, recipient: accepts.payTo, atomicAmount: String(accepts.amount), decimalAmount: atomicToDecimal6(String(accepts.amount)) }
}

/** Free, unauthenticated probe of the real merchant -- no OCD operation needed. */
async function probeOneSourceChallenge(): Promise<LiveChallenge> {
  const res = await fetch(ONESOURCE_LOCAL_PROXY)
  if (res.status !== 402) throw new Error(`expected 402 from OneSource (via local proxy), got ${res.status}`)
  return challengeFromResponse(res, 'OneSource')
}

/**
 * Reads OCD's live preflight price WITHOUT paying. The resumable
 * `/x402/lifecycle/preflight-payment` route requires a real operation's
 * x-ocd-operation-id/x-ocd-recovery-credential headers before its x402
 * payment middleware even runs -- so this can only be probed AFTER a real
 * (free) operation exists. Deliberately sends the EXACT same body
 * op.preflight() will later send for the SAME operation, so this plain,
 * non-paying probe and the real paid call the SDK makes are indistinguishable
 * to the server -- no separate code path, no separate price.
 */
async function probeOcdPreflightChallenge(
  operation: CommerceOperation,
  action: CommerceAction,
  policy: CommercePolicy,
  publication: { preflight: boolean; commerce: boolean }
): Promise<LiveChallenge> {
  const record = operation.currentRecord()
  const res = await fetch('/x402/lifecycle/preflight-payment', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ocd-operation-id': operation.operationId,
      'x-ocd-recovery-credential': record.recoveryCredential,
    },
    body: JSON.stringify({ action, policy, options: {}, references: {}, publication }),
  })
  if (res.status !== 402) throw new Error(`expected 402 from OCD preflight probe, got ${res.status}`)
  return challengeFromResponse(res, 'OCD preflight')
}

// --- lifecycle state -------------------------------------------------------
const PUBLICATION = { preflight: true, commerce: true }
const discoveryClient = createCommerceClient({ endpoint: '', recovery: new HttpRecoveryStore(), trust: { verifyReceipts: true } })
let op: CommerceOperation | null = null
let pinnedAction: CommerceAction | null = null
let pinnedPolicy: CommercePolicy | null = null
let merchantChallenge: LiveChallenge | null = null
let ocdChallenge: LiveChallenge | null = null
let merchantResultDigest: string | null = null

function renderGate(): void {
  const btn = $('btn-execute') as HTMLButtonElement
  const checkbox = $('confirm-checkbox') as HTMLInputElement
  const ready = account !== null && chainId === base.id && merchantChallenge !== null && ocdChallenge !== null && op !== null && checkbox.checked
  btn.disabled = !ready
  const reasons: string[] = []
  if (!account) reasons.push('connect your wallet')
  else if (chainId !== base.id) reasons.push('switch to Base mainnet')
  if (!merchantChallenge || !ocdChallenge || !op) reasons.push('check live prices first')
  if (!checkbox.checked) reasons.push('confirm you understand the payment plan')
  const reasonsEl = $('gate-reasons')
  reasonsEl.innerHTML = ''
  for (const r of reasons) {
    const li = document.createElement('li')
    li.textContent = r
    reasonsEl.appendChild(li)
  }
}

async function checkLivePrices(): Promise<void> {
  if (!account) {
    logLine('Connect your wallet before checking live prices (expected_payer needs your address).')
    return
  }
  $('challenge-status').textContent = 'checking live challenges…'
  try {
    const merchant = await probeOneSourceChallenge()
    merchantChallenge = merchant
    $('live-resource').textContent = ONESOURCE_TRUE_RESOURCE
    $('live-network').textContent = merchant.network
    $('live-asset').textContent = merchant.asset
    $('live-recipient').textContent = merchant.recipient
    $('live-merchant-price').textContent = `$${merchant.decimalAmount} USDC → ${merchant.recipient}`
    logLine(`Live OneSource price: $${merchant.decimalAmount} (${merchant.atomicAmount} atomic) -> ${merchant.recipient}`)

    if (!op) {
      pinnedAction = {
        kind: 'PAYMENT',
        resource: ONESOURCE_TRUE_RESOURCE,
        network: merchant.network,
        asset: merchant.asset,
        amount: merchant.decimalAmount,
        sender: null,
        recipient: merchant.recipient,
      }
      const { policy } = fixedRecipientPolicy({
        maxAmount: merchant.decimalAmount,
        allowedNetwork: merchant.network,
        allowedAsset: merchant.asset,
        expectedRecipient: merchant.recipient,
      })
      pinnedPolicy = { ...policy, expected_payer: account }
      op = await discoveryClient.open({ intent: 'D2.5A first independent merchant reference', action: pinnedAction, policy: pinnedPolicy, publication: PUBLICATION })
      localStorage.setItem(OPERATION_STORAGE_KEY, op.operationId)
      $('result-operation-id').textContent = op.operationId
      logLine(`Operation opened (free): ${op.operationId} (narrow policy: max ${merchant.decimalAmount}, recipient pinned, expected_payer ${account})`)
    }

    const ocd = await probeOcdPreflightChallenge(op, pinnedAction as CommerceAction, pinnedPolicy as CommercePolicy, PUBLICATION)
    ocdChallenge = ocd
    $('live-ocd-fee').textContent = `$${ocd.decimalAmount} USDC → ${ocd.recipient}`
    const aggregate = (BigInt(ocd.atomicAmount) + BigInt(merchant.atomicAmount)).toString()
    $('live-aggregate').textContent = `$${atomicToDecimal6(aggregate)} USDC (${aggregate} atomic)`
    $('challenge-status').textContent = `live as of ${new Date().toISOString()}`
    $('confirm-text').textContent =
      `You are about to authorize TWO real Base USDC payments: $${ocd.decimalAmount} to OCD (${ocd.recipient}), then ` +
      `$${merchant.decimalAmount} to OneSource (${merchant.recipient}). Aggregate maximum: $${atomicToDecimal6(aggregate)} USDC.`
    ;($('confirm-checkbox') as HTMLInputElement).disabled = false
    logLine(`Live OCD preflight fee: $${ocd.decimalAmount} (${ocd.atomicAmount} atomic) -> ${ocd.recipient}`)
    logLine(`Aggregate maximum: $${atomicToDecimal6(aggregate)} USDC`)
  } catch (err: any) {
    $('challenge-status').textContent = `error: ${err?.message ?? err}`
    logLine(`Live price check failed: ${err?.message ?? err}`)
  }
  renderGate()
}

async function tryResumeFromStorage(): Promise<void> {
  const savedId = localStorage.getItem(OPERATION_STORAGE_KEY)
  if (!savedId) return
  const loaded = await discoveryClient.load(savedId).catch(() => null)
  if (!loaded) return
  op = loaded
  $('result-operation-id').textContent = op.operationId
  logLine(`Found a saved operation id from a previous page load: ${op.operationId}. Connect your wallet, then click "Resume this operation" or re-check live prices to continue.`)
  $('recovery').style.display = 'block'
  $('recovery-message').textContent = `Operation ${op.operationId} was previously opened on this machine. Resuming will never create a new operation and never repeats a merchant payment.`
}

async function runFullLifecycle(): Promise<void> {
  if (!op || !pinnedAction || !pinnedPolicy) return
  const btn = $('btn-execute') as HTMLButtonElement
  btn.disabled = true
  try {
    // Everything above this point (open, both live-price probes) used
    // `discoveryClient`'s plain fetch -- nothing could have paid yet.
    // Only NOW, in direct response to the operator's click, do we build a
    // payment-wrapped fetch and hand it to a SECOND client bound to the
    // SAME durable recovery record (client.open() with an existing
    // operationId loads it rather than creating a new one).
    logLine('\n=== Building payment-wrapped client (pays only on an actual 402) ===')
    const payingClient = createCommerceClient({ endpoint: '', recovery: new HttpRecoveryStore(), trust: { verifyReceipts: true }, fetch: buildPayingFetch() })
    const payingOp = await payingClient.open({ operationId: op.operationId, action: pinnedAction, policy: pinnedPolicy, publication: PUBLICATION })

    logLine('\n=== Step 1: OCD preflight (real payment, resumable) ===')
    const evaluation = await payingOp.preflight()
    if (evaluation.kind === 'blocked') {
      logLine(`STOP: preflight returned BLOCK: ${evaluation.reasons.join('; ')}`)
      return
    }
    if (evaluation.kind === 'approval-required') {
      logLine(`STOP: preflight returned REQUIRE_APPROVAL: ${evaluation.reasons.join('; ')}`)
      return
    }
    if (evaluation.kind === 'pending') {
      logLine(`Preflight is still settling: ${evaluation.safeNextAction}`)
      $('recovery').style.display = 'block'
      $('recovery-message').textContent = `Preflight pending: ${evaluation.safeNextAction}`
      return
    }
    if (evaluation.kind === 'terminal-error') {
      logLine(`Preflight failed: ${evaluation.error}`)
      return
    }
    logLine(`PREFLIGHT receipt ${evaluation.receipt.receipt.receipt_id} — decision ALLOW.`)
    $('result-preflight-id').textContent = evaluation.receipt.receipt.receipt_id
    ;($('result-preflight-link') as HTMLAnchorElement).href = explorerUrl(evaluation.receipt.receipt.receipt_id)

    logLine('\n=== Step 2: independent executor authorization + ONE OneSource payment ===')
    const executor = new OneSourceViaLocalProxyExecutor(new X402BaseUsdcExecutor({ signer: buildInjectedSigner() }))
    const execution = await payingOp.execute({ executor })
    if (execution.kind === 'pending') {
      logLine(`Execution ambiguous: ${execution.safeNextAction}`)
      $('recovery').style.display = 'block'
      $('recovery-message').textContent = `Execution ambiguous: ${execution.safeNextAction}. Manual recovery may be required -- see the log.`
      return
    }
    if (execution.kind === 'manual-recovery-required') {
      logLine(`MANUAL RECOVERY REQUIRED: ${execution.reason}. Stopping automatic execution -- no further submission will be attempted.`)
      $('recovery').style.display = 'block'
      $('recovery-message').textContent = `Manual recovery required: ${execution.reason}`
      return
    }
    if (execution.kind === 'terminal-error') {
      logLine(`Execution failed: ${execution.error}`)
      return
    }
    logLine(`Execution recorded. Transaction: ${execution.transactionHash}`)
    $('result-tx').textContent = execution.transactionHash
    ;($('result-tx-link') as HTMLAnchorElement).href = baseExplorerTx(execution.transactionHash)

    // Capture the merchant's own response as buyer-observed evidence (a
    // digest only -- this is NOT independent verification of the service,
    // just a record of what the buyer received).
    try {
      const merchantRes = await fetch(ONESOURCE_LOCAL_PROXY)
      if (merchantRes.ok) {
        const text = await merchantRes.text()
        const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
        merchantResultDigest = 'sha256:' + btoa(String.fromCharCode(...new Uint8Array(digestBuf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        $('result-response-digest').textContent = `${merchantResultDigest} (buyer-observed response, not independently verified)`
        logLine(`Buyer-observed merchant response digest: ${merchantResultDigest}`)
      }
    } catch {
      logLine('Could not capture a buyer-observed merchant response digest (non-fatal).')
    }

    logLine('\n=== Step 3: observe + finalize (free, D2.4 exact-event observation) ===')
    let result = await payingOp.observeAndFinalize()
    while (result.kind === 'pending') {
      logLine(`Observation pending: ${result.safeNextAction}`)
      await new Promise((r) => setTimeout(r, result.retryAfterSeconds ? result.retryAfterSeconds * 1000 : 3000))
      result = await payingOp.observeAndFinalize()
    }
    if (result.kind === 'terminal-error') {
      logLine(`Finalize failed: ${result.error}`)
      return
    }
    logLine(`COMMERCE receipt ${result.receipt.receipt.receipt_id} — execution ${result.receipt.receipt.execution.status}, settlement ${result.receipt.receipt.settlement.status}`)
    $('result-commerce-id').textContent = result.receipt.receipt.receipt_id
    ;($('result-commerce-link') as HTMLAnchorElement).href = explorerUrl(result.receipt.receipt.receipt_id)
    $('result-binding').textContent = result.evidence?.binding_strength ?? 'unknown'
    if (result.evidence) logLine(`Binding strength (derived, not chosen): ${result.evidence.binding_strength}`)

    logLine('\n=== Step 4: verify + export evidence ===')
    const verification = await payingClient.verifyReceipt(result.receipt)
    $('result-commerce-verify').innerHTML = `<span class="pill ${verification.state === 'VALID' ? 'ok' : 'bad'}">${verification.state}</span>`
    logLine(`Commerce receipt verification: ${verification.state} (${verification.code})`)

    const preflightVerification = await payingClient.verifyReceipt(evaluation.receipt)
    $('result-preflight-verify').innerHTML = `<span class="pill ${preflightVerification.state === 'VALID' ? 'ok' : 'bad'}">${preflightVerification.state}</span>`

    const manifest = await buildEvidenceExport({
      operationId: payingOp.operationId,
      preflightReceipt: evaluation.receipt,
      commerceReceipt: result.receipt,
      operationStatus: await payingOp.status(),
      lifecycleEvidence: result.evidence,
      notes: { merchant_response_digest: merchantResultDigest ?? 'unavailable', merchant_response_label: 'buyer-observed response' },
    })
    $('result-evidence-digest').textContent = manifest.manifest_digest
    logLine(`Evidence export manifest digest: ${manifest.manifest_digest}`)
    logLine(JSON.stringify(manifest, null, 2))

    localStorage.removeItem(OPERATION_STORAGE_KEY)
    $('result').style.display = 'block'
    $('recovery').style.display = 'none'
    logLine('\nLifecycle complete.')
  } catch (err: any) {
    logLine(`ABORT: ${err?.message ?? err}`)
  } finally {
    renderGate()
  }
}

// --- wire up ----------------------------------------------------------------
$('btn-connect').addEventListener('click', () => void connectWallet())
$('btn-switch').addEventListener('click', () => void switchToBase())
$('btn-check-prices').addEventListener('click', () => void checkLivePrices())
$('btn-execute').addEventListener('click', () => void runFullLifecycle())
$('btn-resume').addEventListener('click', () => void runFullLifecycle())
;($('confirm-checkbox') as HTMLInputElement).addEventListener('change', renderGate)

void tryResumeFromStorage()
logLine('D2.5A operator ready. Connect your wallet, then check live prices.')
