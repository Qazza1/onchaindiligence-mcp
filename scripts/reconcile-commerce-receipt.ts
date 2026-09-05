/**
 * scripts/reconcile-commerce-receipt.ts — D2.2B2: NO-PAYMENT reconciliation
 * for a Commerce Receipt whose original independent chain observation could
 * not obtain a definitive result (e.g. a transient Base RPC failure at mint
 * time — see src/settlement.ts / src/finalizeRoute.ts's FinalizationPendingError,
 * which now prevents this from happening for future finalizations; this
 * script exists to reconcile a receipt minted before that fix).
 *
 * NEVER deletes, overwrites, or rewrites the prior receipt, its digest, or
 * its receipt_id. It appends a brand-new, separately-signed COMMERCE receipt
 * that independently re-observes the SAME transaction, and one durable
 * idempotency row (receipt_reconciliations) linking the two. Both receipts
 * remain public and resolvable afterward.
 *
 * Input is deliberately narrow: the ONLY thing read from argv is the prior
 * receipt id and the --confirm-reconcile flag. Recipient/amount/asset/
 * network/transaction hash are NEVER accepted as arguments — they are
 * derived exclusively from the stored PREFLIGHT/COMMERCE receipts and the
 * capability row that was consumed to mint the prior receipt.
 *
 * Safety gates, all enforced before any write (see reconcileCommerceReceipt()):
 *   - the prior receipt must exist, be type COMMERCE, and independently
 *     verify VALID
 *   - it must actually be stuck (execution UNKNOWN or settlement UNVERIFIED)
 *     — refuses to "reconcile" an already-definitive receipt
 *   - its linked PREFLIGHT receipt must exist and independently verify VALID
 *   - the finalization capability that was consumed to mint the prior
 *     receipt must be found and must reference the SAME preflight id,
 *     transaction hash, and prior Commerce Receipt id
 *   - no existing reconciliation for this prior receipt may already exist
 *     (idempotent — reruns report the existing reconciled receipt, never
 *     create a second one)
 *   - the fresh chain observation must be DEFINITIVE (reverted, or success
 *     with sufficient confirmations) — otherwise nothing is written
 *
 * Usage:
 *   npx tsx scripts/reconcile-commerce-receipt.ts --receipt OCD-RCP-...                       (dry run; writes nothing)
 *   npx tsx scripts/reconcile-commerce-receipt.ts --receipt OCD-RCP-... --confirm-reconcile    (publishes, if reconcilable)
 */
import { pathToFileURL } from 'node:url'
import {
  getReceiptForFinalization,
  getCapabilityByCommerceReceiptId,
  getReconciliationForPriorReceipt,
  recordReconciliation,
  getCommerceOperation,
  listCommerceObservations,
  type ReconciliationOutcome,
} from '../src/db.js'
import {
  verifyReceiptEnvelope,
  fetchAttestationKeyRegistry,
  normalizeReceiptId,
  buildReceiptCore,
  finalizeReceiptCore,
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  type Receipt,
  type PublicActionReceiptEnvelope,
  type ReceiptCheck,
} from '../src/receipts.js'
import { observeTransaction, isValidTransactionHash, BASE_CAIP2, type SettlementObservation } from '../src/settlement.js'
import { buildCommerceReceiptCore, type FinalizationExecutionInput, type BuiltCommerceReceiptCore } from '../src/commerceReceipt.js'
import { attest } from '../src/attest.js'

export class ReconciliationAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconciliationAbortError'
  }
}

function fail(message: string): never {
  throw new ReconciliationAbortError(message)
}

const CONFIRM_FLAG = '--confirm-reconcile'
const EXECUTION_PROVIDERS = new Set(['x402', 'paybox', 'wallet', 'other'])

export function readReceiptArg(argv: string[]): string {
  const idx = argv.indexOf('--receipt')
  const raw = idx !== -1 ? argv[idx + 1] : undefined
  if (!raw) fail('usage: reconcile-commerce-receipt.ts --receipt OCD-RCP-... [--confirm-reconcile]')
  const normalized = normalizeReceiptId(raw)
  if (!normalized) fail(`"${raw}" is not a valid OCD receipt id`)
  return normalized
}

/** The caller-provided result_digest (if any) recorded on the prior receipt's own service-delivery-verification check — never re-derived from anything new, only carried forward from what was already stored. */
export function priorResultDigest(priorReceipt: Receipt): string | null {
  const check = priorReceipt.checks.find((c) => c.id === 'service-delivery-verification')
  return check?.evidence_digest ?? null
}

export interface ReconcileDependencies {
  getReceiptForFinalization?: typeof getReceiptForFinalization
  getCapabilityByCommerceReceiptId?: typeof getCapabilityByCommerceReceiptId
  getReconciliationForPriorReceipt?: typeof getReconciliationForPriorReceipt
  recordReconciliation?: typeof recordReconciliation
  observeTransaction?: typeof observeTransaction
  fetchKeyRegistry?: () => Promise<Parameters<typeof verifyReceiptEnvelope>[1]>
  signReceipt?: (receipt: Receipt) => Promise<PublicActionReceiptEnvelope['proof']>
}

export type ReconcileOutcome =
  | { kind: 'already-reconciled'; reconciledReceiptId: string }
  | { kind: 'not-definitive'; observation: SettlementObservation }
  | { kind: 'dry-run'; built: BuiltCommerceReceiptCore; observation: SettlementObservation; transactionHash: string }
  | { kind: 'reconciled'; envelope: PublicActionReceiptEnvelope; built: BuiltCommerceReceiptCore }
  | { kind: 'race-already-reconciled'; reconciledReceiptId: string }

/**
 * The full reconciliation orchestration, independent of console/CLI
 * concerns — every dependency is injectable so this is testable without a
 * real database, RPC, or signing call. main() below is a thin wrapper that
 * calls this with no injected deps (the real production behavior) and
 * prints the result.
 */
export async function reconcileCommerceReceipt(
  priorReceiptId: string,
  options: { confirmed: boolean },
  deps: ReconcileDependencies = {}
): Promise<ReconcileOutcome> {
  const d = {
    getReceiptForFinalization: deps.getReceiptForFinalization ?? getReceiptForFinalization,
    getCapabilityByCommerceReceiptId: deps.getCapabilityByCommerceReceiptId ?? getCapabilityByCommerceReceiptId,
    getReconciliationForPriorReceipt: deps.getReconciliationForPriorReceipt ?? getReconciliationForPriorReceipt,
    recordReconciliation: deps.recordReconciliation ?? recordReconciliation,
    observeTransaction: deps.observeTransaction ?? observeTransaction,
    fetchKeyRegistry: deps.fetchKeyRegistry ?? fetchAttestationKeyRegistry,
    signReceipt:
      deps.signReceipt ??
      (async (r: Receipt) => (await attest(r, { purpose: PUBLIC_ACTION_RECEIPT_PURPOSE })).attestation as PublicActionReceiptEnvelope['proof']),
  }

  // --- load + validate the prior (stuck) Commerce Receipt -------------------
  const stored = await d.getReceiptForFinalization(priorReceiptId)
  if (!stored) fail(`no receipt found for id ${priorReceiptId}`)
  const { envelope: priorEnvelope, isPublic } = stored
  if (priorEnvelope.receipt.receipt_type !== 'COMMERCE') {
    fail(`${priorReceiptId} is not a COMMERCE receipt (found ${priorEnvelope.receipt.receipt_type})`)
  }

  const registry = await d.fetchKeyRegistry()
  const priorVerification = verifyReceiptEnvelope(priorEnvelope, registry)
  if (priorVerification.state !== 'VALID') {
    fail(`${priorReceiptId} does not independently verify VALID (${priorVerification.state}: ${priorVerification.code})`)
  }

  const executionStatus = priorEnvelope.receipt.execution.status
  const settlementStatus = priorEnvelope.receipt.settlement.status
  if (executionStatus !== 'UNKNOWN' && settlementStatus !== 'UNVERIFIED') {
    fail(`${priorReceiptId} is already definitive (execution=${executionStatus}, settlement=${settlementStatus}) — nothing to reconcile`)
  }

  const transactionHash = priorEnvelope.receipt.execution.transaction_hash
  if (!isValidTransactionHash(transactionHash)) fail(`${priorReceiptId} has no valid transaction_hash recorded`)

  const preflightReceiptId = priorEnvelope.receipt.links.preflight_receipt_id
  if (!preflightReceiptId) fail(`${priorReceiptId} has no linked preflight_receipt_id`)

  // --- load + validate the linked PREFLIGHT receipt -------------------------
  const preflightStored = await d.getReceiptForFinalization(preflightReceiptId)
  if (!preflightStored) fail(`linked preflight receipt ${preflightReceiptId} could not be found`)
  if (preflightStored.envelope.receipt.receipt_type !== 'PREFLIGHT') fail(`${preflightReceiptId} is not a PREFLIGHT receipt`)
  const preflightVerification = verifyReceiptEnvelope(preflightStored.envelope, registry)
  if (preflightVerification.state !== 'VALID') {
    fail(`linked preflight ${preflightReceiptId} does not independently verify VALID (${preflightVerification.state}: ${preflightVerification.code})`)
  }
  const preflightReceipt = preflightStored.envelope.receipt

  // --- cross-check the consumed capability record ---------------------------
  const capability = await d.getCapabilityByCommerceReceiptId(priorReceiptId)
  if (!capability) fail(`no finalization capability record references ${priorReceiptId} — refusing to reconcile an unexplained receipt`)
  if (capability.preflightReceiptId !== preflightReceiptId) {
    fail('consumed capability references a different preflight receipt than the one linked from the Commerce Receipt')
  }
  if (capability.consumedTransactionHash !== transactionHash) {
    fail('consumed capability references a different transaction hash than the one recorded on the Commerce Receipt')
  }
  if (capability.commerceReceiptId !== priorReceiptId) {
    fail('consumed capability references a different Commerce Receipt id')
  }

  // --- idempotency: never generate more than one reconciliation ------------
  const existingReconciliation = await d.getReconciliationForPriorReceipt(priorReceiptId)
  if (existingReconciliation) {
    return { kind: 'already-reconciled', reconciledReceiptId: existingReconciliation.reconciledReceiptId }
  }

  // --- independently re-observe the SAME transaction ------------------------
  const observation = await d.observeTransaction(
    transactionHash,
    preflightReceipt.action.network ?? BASE_CAIP2,
    preflightReceipt.action.asset ?? ''
  )
  const definitive = observation.state === 'reverted' || (observation.state === 'success' && observation.sufficientlyConfirmed)
  if (!definitive) return { kind: 'not-definitive', observation }

  const executionProvider = priorEnvelope.receipt.execution.provider
  if (!executionProvider || !EXECUTION_PROVIDERS.has(executionProvider)) {
    fail(`prior receipt's execution.provider ("${executionProvider}") is not a recognized execution provider`)
  }
  const executionInput: FinalizationExecutionInput = {
    transaction_hash: transactionHash,
    execution_provider: executionProvider as FinalizationExecutionInput['execution_provider'],
    provider_reference: null,
    result_digest: priorResultDigest(priorEnvelope.receipt),
  }

  const built = buildCommerceReceiptCore(preflightReceipt, executionInput, observation)
  if (!options.confirmed) return { kind: 'dry-run', built, observation, transactionHash }

  // --- build, sign, verify, and durably record the reconciliation ----------
  const priorObservationCheck: ReceiptCheck = {
    id: 'prior-commerce-observation',
    result: 'PASS',
    summary:
      `This receipt is a later independent re-observation of the same transaction after the prior Commerce Receipt ` +
      `(${priorReceiptId}) could not obtain complete RPC confirmation.`,
    evidence_digest: priorEnvelope.receipt.receipt_digest,
  }
  const limitations = [
    ...built.limitations,
    `Prior Commerce Receipt for this transaction: ${priorReceiptId} (issued ${priorEnvelope.receipt.issued_at}, recorded ` +
      `execution ${priorEnvelope.receipt.execution.status} / settlement ${priorEnvelope.receipt.settlement.status} due to ` +
      `a transient RPC failure; not deleted or modified).`,
  ]

  const core = buildReceiptCore({
    receipt_type: 'COMMERCE',
    issued_at: new Date().toISOString(),
    action: built.action,
    decision: preflightReceipt.decision, // copied verbatim -- never re-evaluated here
    execution: built.execution,
    settlement: built.settlement,
    checks: [...built.checks, priorObservationCheck],
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: preflightReceiptId },
    limitations,
  })
  const receipt = finalizeReceiptCore(core)
  const proof = await d.signReceipt(receipt)
  const envelope: PublicActionReceiptEnvelope = { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }

  const finalVerification = verifyReceiptEnvelope(envelope, registry)
  if (finalVerification.state !== 'VALID') {
    fail(`generated reconciliation receipt did not verify VALID (${finalVerification.code}: ${finalVerification.message}) — not published`)
  }

  const outcome: ReconciliationOutcome = await d.recordReconciliation({ priorReceiptId, reconciledEnvelope: envelope, isPublic })
  if (outcome.kind === 'already-reconciled') {
    return { kind: 'race-already-reconciled', reconciledReceiptId: outcome.reconciledReceiptId }
  }
  return { kind: 'reconciled', envelope, built }
}

// ---------------------------------------------------------------------
// D2.5A: reconciling a Commerce Receipt that is ALREADY correctly
// definitive (execution CONFIRMED, settlement CONFIRMED) but was signed
// before its commerce-lifecycle evidence bundle digest was committed into
// links.agent_evidence_bundle_digest (a confirmed live defect, since fixed
// at the source in lifecycleFinalizeRoute.ts/finalizeRoute.ts -- see those
// files' own headers). This is the OPPOSITE precondition of
// reconcileCommerceReceipt() above (which is for a still-INDEFINITE
// receipt) -- deliberately a separate function so that well-tested,
// already-proven D2.2B2 logic is never touched to add this narrower case.
//
// NEVER re-observes or re-derives the chain conclusion: execution and
// settlement did not change and are copied verbatim from the prior
// receipt. The evidence bundle itself is not recomputed either -- it is
// read back from the EXACT SAME commerce_observations row the original
// (buggy) finalize call already wrote, so the reconciled receipt links to
// the identical bundle_digest/binding_strength that was already reported.
// No executor call, no payment, no chain write of any kind.
// ---------------------------------------------------------------------

export interface EvidenceLinkReconcileDependencies {
  getReceiptForFinalization?: typeof getReceiptForFinalization
  getCapabilityByCommerceReceiptId?: typeof getCapabilityByCommerceReceiptId
  getReconciliationForPriorReceipt?: typeof getReconciliationForPriorReceipt
  recordReconciliation?: typeof recordReconciliation
  getCommerceOperation?: typeof getCommerceOperation
  listCommerceObservations?: typeof listCommerceObservations
  fetchKeyRegistry?: () => Promise<Parameters<typeof verifyReceiptEnvelope>[1]>
  signReceipt?: (receipt: Receipt) => Promise<PublicActionReceiptEnvelope['proof']>
}

export type EvidenceLinkReconcileOutcome =
  | { kind: 'already-reconciled'; reconciledReceiptId: string }
  | { kind: 'dry-run'; bundleDigest: string; bindingStrength: string }
  | { kind: 'reconciled'; envelope: PublicActionReceiptEnvelope }
  | { kind: 'race-already-reconciled'; reconciledReceiptId: string }

/**
 * `operationId` is a required, explicit argument (never derived/guessed):
 * there is no reverse lookup from a Commerce Receipt back to the operation
 * that produced it, and inventing one for a one-off reconciliation script
 * would be a wider, riskier change than this fix needs.
 */
export async function reconcileMissingEvidenceLink(
  priorReceiptId: string,
  operationId: string,
  options: { confirmed: boolean },
  deps: EvidenceLinkReconcileDependencies = {}
): Promise<EvidenceLinkReconcileOutcome> {
  const d = {
    getReceiptForFinalization: deps.getReceiptForFinalization ?? getReceiptForFinalization,
    getCapabilityByCommerceReceiptId: deps.getCapabilityByCommerceReceiptId ?? getCapabilityByCommerceReceiptId,
    getReconciliationForPriorReceipt: deps.getReconciliationForPriorReceipt ?? getReconciliationForPriorReceipt,
    recordReconciliation: deps.recordReconciliation ?? recordReconciliation,
    getCommerceOperation: deps.getCommerceOperation ?? getCommerceOperation,
    listCommerceObservations: deps.listCommerceObservations ?? listCommerceObservations,
    fetchKeyRegistry: deps.fetchKeyRegistry ?? fetchAttestationKeyRegistry,
    signReceipt:
      deps.signReceipt ??
      (async (r: Receipt) => (await attest(r, { purpose: PUBLIC_ACTION_RECEIPT_PURPOSE })).attestation as PublicActionReceiptEnvelope['proof']),
  }

  // --- load + validate the prior Commerce Receipt ---------------------------
  const stored = await d.getReceiptForFinalization(priorReceiptId)
  if (!stored) fail(`no receipt found for id ${priorReceiptId}`)
  const { envelope: priorEnvelope, isPublic } = stored
  if (priorEnvelope.receipt.receipt_type !== 'COMMERCE') {
    fail(`${priorReceiptId} is not a COMMERCE receipt (found ${priorEnvelope.receipt.receipt_type})`)
  }

  const registry = await d.fetchKeyRegistry()
  const priorVerification = verifyReceiptEnvelope(priorEnvelope, registry)
  if (priorVerification.state !== 'VALID') {
    fail(`${priorReceiptId} does not independently verify VALID (${priorVerification.state}: ${priorVerification.code})`)
  }

  if (priorEnvelope.receipt.links.agent_evidence_bundle_digest !== null) {
    fail(`${priorReceiptId} already carries an evidence bundle link -- nothing to reconcile`)
  }
  const executionStatus = priorEnvelope.receipt.execution.status
  const settlementStatus = priorEnvelope.receipt.settlement.status
  if (executionStatus !== 'CONFIRMED' || settlementStatus !== 'CONFIRMED') {
    fail(
      `${priorReceiptId} is not a definitively confirmed receipt (execution=${executionStatus}, settlement=${settlementStatus}) -- ` +
        `use reconcileCommerceReceipt() for a still-indefinite receipt instead; this function never re-derives the chain conclusion`
    )
  }

  const transactionHash = priorEnvelope.receipt.execution.transaction_hash
  if (!isValidTransactionHash(transactionHash)) fail(`${priorReceiptId} has no valid transaction_hash recorded`)

  const preflightReceiptId = priorEnvelope.receipt.links.preflight_receipt_id
  if (!preflightReceiptId) fail(`${priorReceiptId} has no linked preflight_receipt_id`)

  const preflightStored = await d.getReceiptForFinalization(preflightReceiptId)
  if (!preflightStored) fail(`linked preflight receipt ${preflightReceiptId} could not be found`)
  if (preflightStored.envelope.receipt.receipt_type !== 'PREFLIGHT') fail(`${preflightReceiptId} is not a PREFLIGHT receipt`)
  const preflightVerification = verifyReceiptEnvelope(preflightStored.envelope, registry)
  if (preflightVerification.state !== 'VALID') {
    fail(`linked preflight ${preflightReceiptId} does not independently verify VALID (${preflightVerification.state}: ${preflightVerification.code})`)
  }

  // --- cross-check the consumed capability record ---------------------------
  const capability = await d.getCapabilityByCommerceReceiptId(priorReceiptId)
  if (!capability) fail(`no finalization capability record references ${priorReceiptId} -- refusing to reconcile an unexplained receipt`)
  if (capability.preflightReceiptId !== preflightReceiptId) {
    fail('consumed capability references a different preflight receipt than the one linked from the Commerce Receipt')
  }
  if (capability.consumedTransactionHash !== transactionHash) {
    fail('consumed capability references a different transaction hash than the one recorded on the Commerce Receipt')
  }
  if (capability.commerceReceiptId !== priorReceiptId) {
    fail('consumed capability references a different Commerce Receipt id')
  }

  // --- cross-check the operation matches this receipt's own preflight ------
  const op = await d.getCommerceOperation(operationId)
  if (!op) fail(`no commerce operation found for id ${operationId}`)
  if (op.preflightReceiptId !== preflightReceiptId) {
    fail(`operation ${operationId}'s own preflight receipt does not match the one linked from ${priorReceiptId} -- wrong operation supplied`)
  }

  // --- idempotency: never generate more than one reconciliation ------------
  const existingReconciliation = await d.getReconciliationForPriorReceipt(priorReceiptId)
  if (existingReconciliation) {
    return { kind: 'already-reconciled', reconciledReceiptId: existingReconciliation.reconciledReceiptId }
  }

  // --- find the EXISTING lifecycle evidence for this exact transaction -----
  // Never recomputed/re-observed: reused exactly as the original (buggy)
  // finalize call already derived and durably stored it.
  const observations = await d.listCommerceObservations(operationId)
  const matching = observations.find((o) => o.transactionHash.toLowerCase() === transactionHash.toLowerCase() && o.bundleDigest !== null)
  if (!matching || !matching.bundleDigest) {
    fail(`no stored lifecycle-evidence observation with a bundle digest was found for operation ${operationId} / transaction ${transactionHash} -- nothing to link`)
  }
  const bundleDigest = matching.bundleDigest
  const bindingStrength = matching.bindingStrength

  if (!options.confirmed) return { kind: 'dry-run', bundleDigest, bindingStrength }

  // --- build, sign, verify, and durably record the reconciliation ----------
  const priorReceiptCheck: ReceiptCheck = {
    id: 'prior-commerce-receipt',
    result: 'PASS',
    summary:
      `This receipt is a corrected re-issue of ${priorReceiptId}, carrying the SAME independently-observed execution and ` +
      `settlement conclusion (neither was re-derived), now with its commerce-lifecycle evidence bundle properly linked -- the ` +
      `prior receipt was signed before that link was committed to links.agent_evidence_bundle_digest.`,
    evidence_digest: priorEnvelope.receipt.receipt_digest,
  }
  const limitations = [
    ...priorEnvelope.receipt.limitations,
    `Prior Commerce Receipt for this transaction: ${priorReceiptId} (issued ${priorEnvelope.receipt.issued_at}; historical, not ` +
      `deleted or modified; missing its evidence bundle link due to a since-fixed defect in the finalize route).`,
  ]

  const core = buildReceiptCore({
    receipt_type: 'COMMERCE',
    issued_at: new Date().toISOString(),
    action: priorEnvelope.receipt.action,
    decision: priorEnvelope.receipt.decision, // copied verbatim -- never re-evaluated here
    execution: priorEnvelope.receipt.execution, // copied verbatim -- the chain conclusion did not change
    settlement: priorEnvelope.receipt.settlement, // copied verbatim -- the chain conclusion did not change
    checks: [...priorEnvelope.receipt.checks, priorReceiptCheck],
    links: { agent_evidence_bundle_digest: bundleDigest, preflight_receipt_id: preflightReceiptId },
    limitations,
  })
  const receipt = finalizeReceiptCore(core)
  const proof = await d.signReceipt(receipt)
  const envelope: PublicActionReceiptEnvelope = { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }

  const finalVerification = verifyReceiptEnvelope(envelope, registry)
  if (finalVerification.state !== 'VALID') {
    fail(`generated reconciliation receipt did not verify VALID (${finalVerification.code}: ${finalVerification.message}) -- not published`)
  }

  const outcome: ReconciliationOutcome = await d.recordReconciliation({ priorReceiptId, reconciledEnvelope: envelope, isPublic })
  if (outcome.kind === 'already-reconciled') {
    return { kind: 'race-already-reconciled', reconciledReceiptId: outcome.reconciledReceiptId }
  }
  return { kind: 'reconciled', envelope }
}

// ---------------------------------------------------------------------
// CLI adapter — console-only concerns, no logic of its own.
// ---------------------------------------------------------------------

function readOperationArg(argv: string[]): string | null {
  const idx = argv.indexOf('--operation')
  return idx !== -1 ? (argv[idx + 1] ?? null) : null
}

async function main(): Promise<void> {
  const priorReceiptId = readReceiptArg(process.argv)
  const confirmed = process.argv.includes(CONFIRM_FLAG)
  const operationId = readOperationArg(process.argv)
  console.log(confirmed ? 'MODE: CONFIRM (will write to the database if reconcilable)' : 'MODE: DRY RUN (no database write)')
  console.log(`Reconciling: ${priorReceiptId}`)

  // --operation switches to the D2.5A evidence-link reconciliation path
  // (an already-definitive receipt missing its evidence bundle link) --
  // otherwise, the original D2.2B2 path (a still-indefinite receipt) runs
  // exactly as before.
  if (operationId) {
    console.log(`Mode: evidence-link reconciliation for operation ${operationId}`)
    const evidenceOutcome = await reconcileMissingEvidenceLink(priorReceiptId, operationId, { confirmed })

    if (evidenceOutcome.kind === 'already-reconciled') {
      console.log(`\nALREADY RECONCILED: ${priorReceiptId} -> ${evidenceOutcome.reconciledReceiptId}`)
      console.log('No further action taken (idempotent).')
      return
    }
    if (evidenceOutcome.kind === 'dry-run') {
      console.log('\n=== Existing stored lifecycle evidence for this transaction ===')
      console.log(`  bundle_digest:    ${evidenceOutcome.bundleDigest}`)
      console.log(`  binding_strength: ${evidenceOutcome.bindingStrength}`)
      console.log('\nThis was a DRY RUN. Nothing was written to the database.')
      console.log(`To publish this reconciliation: npx tsx scripts/reconcile-commerce-receipt.ts --receipt ${priorReceiptId} --operation ${operationId} ${CONFIRM_FLAG}`)
      return
    }
    if (evidenceOutcome.kind === 'race-already-reconciled') {
      console.log(`\nRACE: another run already reconciled this receipt -> ${evidenceOutcome.reconciledReceiptId}. Nothing new was written.`)
      return
    }
    console.log(`\nRECONCILED: ${priorReceiptId} -> ${evidenceOutcome.envelope.receipt.receipt_id}`)
    console.log(`  GET /receipts/${priorReceiptId}                     (historical: agent_evidence_bundle_digest null, unchanged)`)
    console.log(`  GET /receipts/${evidenceOutcome.envelope.receipt.receipt_id}  (evidence bundle now linked)`)
    return
  }

  const outcome = await reconcileCommerceReceipt(priorReceiptId, { confirmed })

  if (outcome.kind === 'already-reconciled') {
    console.log(`\nALREADY RECONCILED: ${priorReceiptId} -> ${outcome.reconciledReceiptId}`)
    console.log('No further action taken (idempotent).')
    return
  }

  if (outcome.kind === 'not-definitive') {
    console.log('\n=== Independent re-observation of the same transaction ===')
    console.log(`  state: ${outcome.observation.state}`)
    console.log(`  confirmations: ${outcome.observation.confirmations ?? 'unknown'} (sufficient: ${outcome.observation.sufficientlyConfirmed})`)
    console.log('\nNOT YET DEFINITIVE: chain observation still cannot confirm this transaction one way or the other.')
    console.log('Nothing was written. Re-run this script again later.')
    return
  }

  if (outcome.kind === 'dry-run') {
    console.log('\n=== Independent re-observation of the same transaction ===')
    console.log(`  transaction: ${outcome.transactionHash}`)
    console.log(`  state: ${outcome.observation.state}`)
    console.log(`  confirmations: ${outcome.observation.confirmations ?? 'unknown'} (sufficient: ${outcome.observation.sufficientlyConfirmed})`)
    console.log(`  transfers of the expected asset: ${outcome.observation.transfers.length}`)
    for (const t of outcome.observation.transfers) {
      console.log(`    ${t.amountAtomic} atomic ${t.assetContract} : ${t.from} -> ${t.to}`)
    }
    console.log('\n=== What the reconciled receipt would report ===')
    console.log(`  execution.status:  ${outcome.built.execution.status}`)
    console.log(`  settlement.status: ${outcome.built.settlement.status}`)
    for (const check of outcome.built.checks) {
      console.log(`    ${check.result === 'PASS' ? 'PASS' : check.result} — ${check.id}`)
    }
    console.log('\nThis was a DRY RUN. Nothing was written to the database.')
    console.log(`To publish this reconciliation: npx tsx scripts/reconcile-commerce-receipt.ts --receipt ${priorReceiptId} ${CONFIRM_FLAG}`)
    return
  }

  if (outcome.kind === 'race-already-reconciled') {
    console.log(`\nRACE: another run already reconciled this receipt -> ${outcome.reconciledReceiptId}. Nothing new was written.`)
    return
  }

  console.log(`\nRECONCILED: ${priorReceiptId} -> ${outcome.envelope.receipt.receipt_id}`)
  console.log(`  GET /receipts/${priorReceiptId}                     (historical: execution UNKNOWN / settlement UNVERIFIED, unchanged)`)
  console.log(`  GET /receipts/${outcome.envelope.receipt.receipt_id}  (current definitive observation)`)
}

// Only run when executed directly, never as a side effect of a test file
// importing this module's exported pure functions for unit testing.
const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`ABORT: ${error instanceof Error ? error.message : 'unknown failure'}`)
    process.exit(1)
  })
}
