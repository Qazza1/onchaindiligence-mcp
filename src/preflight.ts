/**
 * preflight.ts — Payment Preflight v1 (D2.1).
 *
 * "Before an autonomous agent pays, OnChainDiligence evaluates the proposed
 * payment against a caller-defined structured policy and evidence, then
 * issues a portable signed PREFLIGHT receipt explaining the decision."
 *
 * SCOPE: this evaluates a proposal against DETERMINISTIC, STRUCTURED policy
 * fields only. There is no natural-language policy interpreter here, and
 * none should be added — "don't spend too much" has no defensible
 * deterministic meaning. A future mandate compiler may translate human
 * intent into the structured `PreflightPolicy` shape this module consumes;
 * this module never attempts that translation itself.
 *
 * OCD IS NOT THE WALLET. OCD does not hold funds, does not execute the
 * payment, and does not override wallet/PayBox/x402-client authorization.
 * This produces a recommendation (ALLOW / REQUIRE_APPROVAL / BLOCK) with a
 * verifiable paper trail; the execution layer applies its own, independent
 * authorization afterward. See docs/PAYMENT_PREFLIGHT.md.
 *
 * This is the ONE service function both transports adapt to — HTTP
 * (src/discovery.ts) and MCP (src/server.ts) both call `preflightPayment`
 * directly rather than each re-implementing policy evaluation.
 */
import { screenAddress, type SanctionsResult } from './chainalysis.js'
import { isValidEvmAddress } from './inputValidation.js'
import { isCanonicalDecimalAmount, isAmountWithinMax } from './money.js'
import { attest } from './attest.js'
import { putReceipt as putReceiptDurable } from './db.js'
import { mintFinalizationCapability, type FinalizationCapability } from './capability.js'
import {
  buildReceiptCore,
  finalizeReceiptCore,
  fetchAttestationKeyRegistry,
  verifyReceiptEnvelope,
  PUBLIC_ACTION_RECEIPT_SCHEMA,
  PUBLIC_ACTION_RECEIPT_PURPOSE,
  type ReceiptCheck,
  type ReceiptDecision,
  type Receipt,
  type PublicActionReceiptEnvelope,
} from './receipts.js'

const FINALIZATION_ENDPOINT = 'https://mcp.onchaindiligence.com/receipts/finalize'

/**
 * Test-only seams. Every field defaults to the real production
 * implementation, so ordinary callers (the HTTP route, the MCP tool) never
 * pass this at all and get exactly the live behaviour. Tests inject a fake
 * sanctions screener and/or a locally-keyed signer so the full pipeline —
 * including "does the receipt verify VALID" — is provable without hitting
 * the live network, mirroring the pattern already used by
 * onchaindiligence/packages/agent-evidence's own test suite.
 */
export interface PreflightDependencies {
  screenRecipient?: (address: string) => Promise<SanctionsResult>
  signReceipt?: (receipt: Receipt) => Promise<PublicActionReceiptEnvelope['proof']>
  fetchKeyRegistry?: () => Promise<Parameters<typeof verifyReceiptEnvelope>[1]>
  storeReceipt?: (envelope: PublicActionReceiptEnvelope, options: { isPublic: boolean }) => Promise<void>
  mintCapability?: (preflightReceiptId: string, preflightReceiptDigest: string, publishCommerce: boolean) => Promise<FinalizationCapability>
}

export class PreflightInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreflightInputError'
  }
}

export class PreflightServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreflightServiceError'
  }
}

// ---------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------

export interface PreflightAction {
  /** v1 supports exactly one kind. Kept as a field for forward compatibility. */
  kind: 'PAYMENT'
  /** URL of the resource/service the payment is for, if any. */
  resource: string | null
  /** CAIP-2 network identifier, e.g. "eip155:8453" for Base mainnet. */
  network: string
  /** Canonical ERC-20 token contract address — never a bare ticker like "USDC". */
  asset: string
  /** Canonical decimal string, e.g. "1.00". Never a float. */
  amount: string
  sender: string | null
  recipient: string
}

export interface PreflightPolicy {
  max_amount: string | null
  allowed_networks: string[] | null
  allowed_assets: string[] | null
  expected_recipient: string | null
  allowed_resource_origins: string[] | null
}

export interface PreflightOptions {
  screen_recipient_sanctions: boolean
}

export interface PreflightReferences {
  mandate_digest: string | null
}

/**
 * Opt-in publication preference (D2.2). BOTH default false: a receipt is
 * always returned inline to its caller regardless of this setting, but is
 * only ever externally resolvable via GET /receipts/:id when its owner
 * explicitly asked for that. Never infer "public" from anything else.
 */
export interface PreflightPublication {
  preflight: boolean
  commerce: boolean
}

export interface PreflightInput {
  action: PreflightAction
  policy: PreflightPolicy
  options: PreflightOptions
  references: PreflightReferences
  publication: PreflightPublication
}

export interface PreflightResult {
  decision: ReceiptDecision
  checks: ReceiptCheck[]
  receipt: PublicActionReceiptEnvelope
  /**
   * One-time capability authorizing exactly one thing: finalizing THIS
   * preflight into a Commerce Receipt at POST /receipts/finalize. It does
   * NOT authorize payment. `capability` is operational secret material —
   * returned here once, never stored in plaintext, never logged, and never
   * included in the (public) receipt envelope above.
   */
  finalization: {
    capability: string
    expires_at: string
    endpoint: string
  }
}

const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$/
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * D2.3 (Task 5): unknown fields on a consequential input object must never
 * be silently discarded — a typo like "max_amunt" would otherwise leave the
 * real "max_amount" constraint unset, silently producing an UNCONSTRAINED
 * policy instead of the capped one the caller almost certainly intended.
 * Reject outright instead.
 */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new PreflightInputError(
        `${label} has an unrecognized field: "${key}" — rejected rather than silently ignored, since a mistyped field could otherwise silently produce a less restrictive policy than intended`
      )
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PreflightInputError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return requireString(value, field)
}

function optionalStringArray(value: unknown, field: string): string[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new PreflightInputError(
      `${field} must be null, or a non-empty array of non-empty strings (an empty array can never match anything)`
    )
  }
  return value as string[]
}

function requireEvmAddress(value: unknown, field: string): string {
  const s = requireString(value, field)
  if (!isValidEvmAddress(s)) {
    throw new PreflightInputError(`${field} must be a 0x-prefixed, 40-hex-character EVM address`)
  }
  return s
}

function optionalEvmAddress(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return requireEvmAddress(value, field)
}

function requireOrigin(value: string, field: string): string {
  try {
    const url = new URL(value)
    if (url.origin !== value) throw new Error('not a bare origin')
    return value
  } catch {
    throw new PreflightInputError(`${field} entry "${value}" must be a bare origin like "https://service.example"`)
  }
}

/**
 * Shared by parsePreflightInput (paid) and parseInspectInput (free) — the
 * exact same action/policy validation, so a proposal that is well-formed for
 * one is well-formed for the other. Never touches the network.
 */
const ACTION_KEYS = ['kind', 'resource', 'network', 'asset', 'amount', 'sender', 'recipient'] as const

function parseAction(raw: unknown): PreflightAction {
  if (!isPlainObject(raw)) throw new PreflightInputError('action must be an object')
  rejectUnknownKeys(raw, ACTION_KEYS, 'action')
  const a = raw
  if (a.kind !== 'PAYMENT') {
    throw new PreflightInputError('action.kind must be "PAYMENT" (the only supported kind in v1)')
  }
  const network = requireString(a.network, 'action.network')
  if (!CAIP2_PATTERN.test(network)) {
    throw new PreflightInputError('action.network must be a CAIP-2 identifier, e.g. "eip155:8453"')
  }
  const asset = requireEvmAddress(a.asset, 'action.asset')
  const amount = requireString(a.amount, 'action.amount')
  if (!isCanonicalDecimalAmount(amount)) {
    throw new PreflightInputError(
      'action.amount must be a canonical decimal string (no leading zeros, no sign, no scientific notation), e.g. "1.00" — never a float or a ticker-scaled integer'
    )
  }
  const recipient = requireEvmAddress(a.recipient, 'action.recipient')
  const sender = optionalEvmAddress(a.sender, 'action.sender')
  const resource = optionalString(a.resource, 'action.resource')
  if (resource !== null) {
    try {
      new URL(resource)
    } catch {
      throw new PreflightInputError('action.resource must be a valid URL')
    }
  }
  return { kind: 'PAYMENT', resource, network, asset, amount, sender, recipient }
}

const POLICY_KEYS = [
  'max_amount',
  'allowed_networks',
  'allowed_assets',
  'expected_recipient',
  'allowed_resource_origins',
  'acknowledge_unconstrained',
] as const

function parsePolicy(raw: unknown): PreflightPolicy {
  if (!isPlainObject(raw)) throw new PreflightInputError('policy must be an object')
  rejectUnknownKeys(raw, POLICY_KEYS, 'policy')
  const p = raw
  const maxAmount = optionalString(p.max_amount, 'policy.max_amount')
  if (maxAmount !== null && !isCanonicalDecimalAmount(maxAmount)) {
    throw new PreflightInputError('policy.max_amount must be a canonical decimal string, or null')
  }
  const allowedNetworks = optionalStringArray(p.allowed_networks, 'policy.allowed_networks')
  if (allowedNetworks) {
    for (const n of allowedNetworks) {
      if (!CAIP2_PATTERN.test(n)) throw new PreflightInputError(`policy.allowed_networks contains a non-CAIP-2 value: "${n}"`)
    }
  }
  const allowedAssets = optionalStringArray(p.allowed_assets, 'policy.allowed_assets')
  if (allowedAssets) {
    for (const asset_ of allowedAssets) {
      if (!isValidEvmAddress(asset_)) {
        throw new PreflightInputError(`policy.allowed_assets contains a non-address value: "${asset_}" (use contract addresses, not ticker symbols)`)
      }
    }
  }
  const expectedRecipient = optionalEvmAddress(p.expected_recipient, 'policy.expected_recipient')
  const allowedResourceOrigins = optionalStringArray(p.allowed_resource_origins, 'policy.allowed_resource_origins')
  if (allowedResourceOrigins) {
    for (const origin of allowedResourceOrigins) requireOrigin(origin, 'policy.allowed_resource_origins')
  }

  // D2.3 (Task 5): a policy where every constraint is null/omitted is
  // indistinguishable, on its face, from a caller who forgot to set policy
  // fields at all (e.g. sent `policy: {}` by accident). Since this parser
  // cannot tell "deliberately unconstrained" from "accidentally empty",
  // require an explicit, separate acknowledgment in that one case — this is
  // a structural confirmation that the empty policy was intentional, NOT an
  // authorization: it changes nothing about what evaluatePreflightPolicy()
  // decides, only whether a fully-empty policy is accepted at all.
  if (p.acknowledge_unconstrained !== undefined && typeof p.acknowledge_unconstrained !== 'boolean') {
    throw new PreflightInputError('policy.acknowledge_unconstrained must be a boolean')
  }
  const noConstraintsSet =
    maxAmount === null && allowedNetworks === null && allowedAssets === null && expectedRecipient === null && allowedResourceOrigins === null
  if (noConstraintsSet && p.acknowledge_unconstrained !== true) {
    throw new PreflightInputError(
      'policy has no constraints set (max_amount, allowed_networks, allowed_assets, expected_recipient, and allowed_resource_origins are all null or omitted). ' +
        'If an unconstrained policy is genuinely intended, pass policy.acknowledge_unconstrained: true to confirm this was not an accidental empty/invalid policy.'
    )
  }

  return {
    max_amount: maxAmount,
    allowed_networks: allowedNetworks,
    allowed_assets: allowedAssets,
    expected_recipient: expectedRecipient,
    allowed_resource_origins: allowedResourceOrigins,
  }
}

/**
 * Strict structural validation. Throws PreflightInputError (never touches the
 * network) on any malformed input — callers use this to reject bad requests
 * BEFORE a payment challenge is ever issued.
 */
export function parsePreflightInput(raw: unknown): PreflightInput {
  if (!isPlainObject(raw)) throw new PreflightInputError('body must be a JSON object')
  rejectUnknownKeys(raw, ['action', 'policy', 'options', 'references', 'publication'], 'body')

  const action = parseAction(raw.action)
  const policy = parsePolicy(raw.policy)

  const rawOptions = raw.options ?? {}
  if (!isPlainObject(rawOptions)) throw new PreflightInputError('options must be an object')
  rejectUnknownKeys(rawOptions, ['screen_recipient_sanctions'], 'options')
  if (rawOptions.screen_recipient_sanctions !== undefined && typeof rawOptions.screen_recipient_sanctions !== 'boolean') {
    throw new PreflightInputError('options.screen_recipient_sanctions must be a boolean')
  }
  const options: PreflightOptions = { screen_recipient_sanctions: rawOptions.screen_recipient_sanctions === true }

  const rawReferences = raw.references ?? {}
  if (!isPlainObject(rawReferences)) throw new PreflightInputError('references must be an object')
  rejectUnknownKeys(rawReferences, ['mandate_digest'], 'references')
  let mandateDigest: string | null = null
  if (rawReferences.mandate_digest !== undefined && rawReferences.mandate_digest !== null) {
    if (typeof rawReferences.mandate_digest !== 'string' || !DIGEST_PATTERN.test(rawReferences.mandate_digest)) {
      throw new PreflightInputError('references.mandate_digest must be a "sha256:<base64url>" content digest, or null')
    }
    mandateDigest = rawReferences.mandate_digest
  }
  const references: PreflightReferences = { mandate_digest: mandateDigest }

  const rawPublication = raw.publication ?? {}
  if (!isPlainObject(rawPublication)) throw new PreflightInputError('publication must be an object')
  rejectUnknownKeys(rawPublication, ['preflight', 'commerce'], 'publication')
  if (rawPublication.preflight !== undefined && typeof rawPublication.preflight !== 'boolean') {
    throw new PreflightInputError('publication.preflight must be a boolean')
  }
  if (rawPublication.commerce !== undefined && typeof rawPublication.commerce !== 'boolean') {
    throw new PreflightInputError('publication.commerce must be a boolean')
  }
  // Default BOTH false: backwards compatible, and privacy-safe-by-default.
  const publication: PreflightPublication = {
    preflight: rawPublication.preflight === true,
    commerce: rawPublication.commerce === true,
  }

  return { action, policy, options, references, publication }
}

// ---------------------------------------------------------------------
// Free inspection (D2.1A) — pure deterministic policy evaluation, no
// external evidence, no signing, no receipt. See inspectPayment() below.
// ---------------------------------------------------------------------

export interface InspectPaymentInput {
  action: PreflightAction
  policy: PreflightPolicy
}

export interface InspectPaymentResult {
  decision: ReceiptDecision
  checks: ReceiptCheck[]
  /** Always false: the free tier performs no external evidence lookups. */
  evidence: { external_checks_performed: false }
  /** Always null: the free tier signs nothing and issues no receipt. */
  receipt: null
}

/**
 * Strict structural validation for the free {action, policy} contract.
 * Deliberately narrower than parsePreflightInput's — no options, no
 * references. `options.screen_recipient_sanctions: true` is explicitly
 * rejected rather than silently ignored: a caller asking for sanctions
 * evidence on the free tier should get a clear error pointing at the paid
 * endpoint, never a result that looks complete but silently skipped it.
 */
export function parseInspectInput(raw: unknown): InspectPaymentInput {
  if (!isPlainObject(raw)) throw new PreflightInputError('body must be a JSON object')

  if (raw.options !== undefined) {
    if (!isPlainObject(raw.options)) throw new PreflightInputError('options must be an object')
    if (raw.options.screen_recipient_sanctions === true) {
      throw new PreflightInputError(
        'options.screen_recipient_sanctions is not available on the free inspection endpoint — use POST /x402/preflight-payment for sanctions-screened evaluation'
      )
    }
  }

  return { action: parseAction(raw.action), policy: parsePolicy(raw.policy) }
}

/**
 * Free, unsigned, deterministic inspection of a proposed payment against
 * structured policy — the same money/address/network/origin rules and the
 * same precedence (FAIL -> BLOCK, else UNKNOWN -> REQUIRE_APPROVAL, else
 * ALLOW) as preflightPayment(), via the identical evaluatePreflightPolicy().
 * Performs NO external evidence lookup (sanctions screening is unavailable
 * here), NO signing call, and produces NO receipt — `receipt` is always
 * `null` and this must never be dressed up to look cryptographically
 * attested. Use preflightPayment() for a VALID-verified signed receipt.
 */
export async function inspectPayment(raw: unknown): Promise<InspectPaymentResult> {
  const input = parseInspectInput(raw)
  const { decision, checks } = await evaluatePreflightPolicy({
    action: input.action,
    policy: input.policy,
    options: { screen_recipient_sanctions: false },
    references: { mandate_digest: null },
    publication: { preflight: false, commerce: false },
  })
  return { decision, checks, evidence: { external_checks_performed: false }, receipt: null }
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Deterministic policy evaluation. No LLM, no natural-language interpretation
 * — every check below is a structured-field comparison. The only network
 * call is the OPTIONAL recipient sanctions screen.
 *
 * Precedence: any hard policy violation (FAIL) forces BLOCK, even if other
 * checks are merely UNKNOWN. Absent any FAIL, any UNKNOWN (insufficient
 * evidence to complete a check the caller actually asked for) forces
 * REQUIRE_APPROVAL. Only when every check that ran is PASS (or the caller
 * left that dimension unconstrained, and so it never ran) is the result
 * ALLOW. UNKNOWN is never silently treated as PASS.
 */
export async function evaluatePreflightPolicy(
  input: PreflightInput,
  deps: PreflightDependencies = {}
): Promise<{ decision: ReceiptDecision; checks: ReceiptCheck[] }> {
  const doScreen = deps.screenRecipient ?? screenAddress
  const { action, policy, options, references } = input
  const checks: ReceiptCheck[] = []
  let hasFail = false
  let hasUnknown = false

  if (policy.max_amount !== null) {
    const within = isAmountWithinMax(action.amount, policy.max_amount)
    checks.push({
      id: 'amount-within-max',
      result: within ? 'PASS' : 'FAIL',
      summary: within
        ? 'The proposed amount is within the caller-configured maximum.'
        : 'The proposed amount exceeds the caller-configured maximum.',
      evidence_digest: null,
    })
    if (!within) hasFail = true
  }

  if (policy.allowed_networks !== null) {
    const allowed = policy.allowed_networks.includes(action.network)
    checks.push({
      id: 'network-allowed',
      result: allowed ? 'PASS' : 'FAIL',
      summary: allowed
        ? 'The proposed network is on the caller-configured allowed network list.'
        : 'The proposed network is not on the caller-configured allowed network list.',
      evidence_digest: null,
    })
    if (!allowed) hasFail = true
  }

  if (policy.allowed_assets !== null) {
    const allowed = policy.allowed_assets.some((a) => addressesEqual(a, action.asset))
    checks.push({
      id: 'asset-allowed',
      result: allowed ? 'PASS' : 'FAIL',
      summary: allowed
        ? 'The proposed asset is on the caller-configured allowed asset list.'
        : 'The proposed asset is not on the caller-configured allowed asset list.',
      evidence_digest: null,
    })
    if (!allowed) hasFail = true
  }

  if (policy.expected_recipient !== null) {
    const matches = addressesEqual(policy.expected_recipient, action.recipient)
    checks.push({
      id: 'recipient-matches-expected',
      result: matches ? 'PASS' : 'FAIL',
      summary: matches
        ? 'The proposed recipient matches the caller-expected recipient.'
        : 'The proposed recipient does not match the caller-expected recipient.',
      evidence_digest: null,
    })
    if (!matches) hasFail = true
  }

  if (policy.allowed_resource_origins !== null) {
    if (action.resource === null) {
      checks.push({
        id: 'resource-origin-allowed',
        result: 'UNKNOWN',
        summary: 'A resource origin restriction is configured, but no resource URL was provided to evaluate it against.',
        evidence_digest: null,
      })
      hasUnknown = true
    } else {
      const origin = new URL(action.resource).origin
      const allowed = policy.allowed_resource_origins.includes(origin)
      checks.push({
        id: 'resource-origin-allowed',
        result: allowed ? 'PASS' : 'FAIL',
        summary: allowed
          ? 'The resource origin is on the caller-configured allowed origin list.'
          : 'The resource origin is not on the caller-configured allowed origin list.',
        evidence_digest: null,
      })
      if (!allowed) hasFail = true
    }
  }

  if (options.screen_recipient_sanctions) {
    try {
      const screened = await doScreen(action.recipient)
      checks.push({
        id: 'recipient-wallet-not-sanctioned',
        result: screened.sanctioned ? 'FAIL' : 'PASS',
        summary: screened.sanctioned
          ? 'Recipient wallet is present on the Chainalysis on-chain sanctions oracle.'
          : 'Recipient wallet was not found on the Chainalysis on-chain sanctions oracle at evaluation time. This does not establish beneficial ownership or general safety — only that this specific source has no match.',
        evidence_digest: null,
      })
      if (screened.sanctioned) hasFail = true
    } catch {
      checks.push({
        id: 'recipient-wallet-not-sanctioned',
        result: 'UNKNOWN',
        summary: 'Recipient sanctions screening could not be completed: the sanctions oracle was unreachable. This is not evidence of safety.',
        evidence_digest: null,
      })
      hasUnknown = true
    }
  }

  // Informational only — referencing a mandate digest never itself affects
  // the decision. OCD does not see or verify the private mandate content.
  if (references.mandate_digest) {
    checks.push({
      id: 'mandate-digest-referenced',
      result: 'NOT_CHECKED',
      summary: 'The caller referenced a private mandate by digest. OnChainDiligence does not see or independently verify private mandate content.',
      evidence_digest: references.mandate_digest,
    })
  }

  let decision: ReceiptDecision
  if (hasFail) {
    decision = {
      status: 'BLOCK',
      authorized: false,
      reasons: checks.filter((c) => c.result === 'FAIL').map((c) => c.summary),
    }
  } else if (hasUnknown) {
    decision = {
      status: 'REQUIRE_APPROVAL',
      authorized: false,
      reasons: checks.filter((c) => c.result === 'UNKNOWN').map((c) => c.summary),
    }
  } else {
    decision = { status: 'ALLOW', authorized: true, reasons: ['All configured policy checks passed.'] }
  }

  return { decision, checks }
}

const PREFLIGHT_LIMITATIONS = [
  'OnChainDiligence does not execute the payment; this receipt records a pre-execution evaluation only.',
  "ALLOW does not guarantee the execution provider (wallet, PayBox, or x402 client) will authorize or complete the payment — OCD's preflight authorization and the execution provider's own authorization are independent gates, and both may be required.",
  'Recipient sanctions screening, where performed, does not establish beneficial ownership or a general safety determination.',
  'Absence from a sanctions source does not imply the recipient is safe in any general sense — only that it was not found on the specific source checked at evaluation time.',
  'This evaluation does not assess service delivery, product quality, or counterparty reputation.',
  "Later execution may differ from the proposed action described here unless the execution layer independently binds itself to this preflight receipt's action fields.",
]

/**
 * The one entry point both transports call. Validates input, runs
 * deterministic policy evaluation (with the optional sanctions check),
 * builds and signs a PREFLIGHT receipt via the existing production signer,
 * and independently re-verifies that receipt before returning — a
 * successful result is never returned with anything less than a VALID
 * receipt proof.
 */
export async function preflightPayment(
  raw: unknown,
  deps: PreflightDependencies = {}
): Promise<PreflightResult> {
  const input = parsePreflightInput(raw)
  const { decision, checks } = await evaluatePreflightPolicy(input, deps)

  const core = buildReceiptCore({
    receipt_type: 'PREFLIGHT',
    issued_at: new Date().toISOString(),
    action: input.action,
    decision,
    execution: {
      provider: null,
      status: 'NOT_SUBMITTED',
      transaction_hash: null,
      submitted_at: null,
      confirmed_at: null,
    },
    settlement: {
      status: 'NOT_APPLICABLE',
      detail: 'No execution was submitted; this is a pre-execution evaluation only.',
    },
    checks,
    links: { agent_evidence_bundle_digest: null, preflight_receipt_id: null },
    limitations: PREFLIGHT_LIMITATIONS,
  })
  const receipt = finalizeReceiptCore(core)

  const proof = deps.signReceipt
    ? await deps.signReceipt(receipt)
    : ((await attest(receipt, { purpose: PUBLIC_ACTION_RECEIPT_PURPOSE })).attestation as PublicActionReceiptEnvelope['proof'])
  const envelope: PublicActionReceiptEnvelope = { schema: PUBLIC_ACTION_RECEIPT_SCHEMA, receipt, proof }

  const registry = await (deps.fetchKeyRegistry ?? fetchAttestationKeyRegistry)()
  const verification = verifyReceiptEnvelope(envelope, registry)
  if (verification.state !== 'VALID') {
    throw new PreflightServiceError(
      `preflight receipt did not verify VALID after signing (${verification.code}: ${verification.message})`
    )
  }

  // Durable storage happens only after the receipt is confirmed genuinely
  // VALID — never persist (let alone publish) a receipt whose own signature
  // doesn't check out. is_public reflects ONLY the caller's explicit
  // publication.preflight choice; default is private.
  await (deps.storeReceipt ?? putReceiptDurable)(envelope, { isPublic: input.publication.preflight })

  // One finalization capability per successful preflight, regardless of
  // decision (ALLOW/REQUIRE_APPROVAL/BLOCK) — it authorizes creating a
  // Commerce Receipt for this lifecycle, never a payment, so there is no
  // reason to withhold it even from a BLOCKed proposal (e.g. after a human
  // overrides a REQUIRE_APPROVAL and executes anyway).
  const capability = await (deps.mintCapability ?? mintFinalizationCapability)(
    envelope.receipt.receipt_id,
    envelope.receipt.receipt_digest,
    input.publication.commerce
  )

  return {
    decision: envelope.receipt.decision,
    checks: envelope.receipt.checks,
    receipt: envelope,
    finalization: {
      capability: capability.token,
      expires_at: capability.expiresAt,
      endpoint: FINALIZATION_ENDPOINT,
    },
  }
}
