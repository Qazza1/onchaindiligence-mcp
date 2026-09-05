/**
 * server.ts — the x402-paid MCP server (plus one free tool).
 *
 * Exposes six PAID MCP tools that agents call and pay for over Streamable
 * HTTP using x402 (USDC on Base): five compliance checks (screen_wallet,
 * screen_name, verify_uk_company, verify_us_company, diligence) plus
 * preflight_payment (D2.1), a structured pre-execution policy evaluation.
 * Each compliance-check tool runs the exact same underlying public-data
 * clients as the HTTP API; preflight_payment runs the same preflightPayment()
 * service the HTTP x402 route uses (see preflight.ts). Cross-surface contract
 * tests are required before claiming response-level equivalence.
 *
 * Plus one FREE tool, inspect_payment (D2.1A), registered via the plain
 * (unpaid) server.tool() — never server.paidTool() — so an agent is never
 * required to pay merely to sanity-check a proposed payment's deterministic
 * fields before deciding whether preflight_payment's paid evidence is worth
 * buying. It shares preflightPayment()'s exact policy evaluator
 * (evaluatePreflightPolicy in preflight.ts) with no external evidence, no
 * signing, and no receipt.
 *
 * Payment model: NON-CUSTODIAL. The x402 facilitator verifies the agent's USDC
 * payment to our recipient address before the tool body runs. We never hold funds.
 *
 * SIGNING: every tool result is wrapped in the same Ed25519 attestation envelope
 * the HTTP API returns — `{ data, attestation }` — so an agent can verify at
 * /verify that the result came from us, unaltered. Signing is done by POSTing to
 * the API's authenticated /attest route rather than holding a copy of the
 * private key in this deployment (see attest.ts). Signing readiness is checked
 * before payment middleware and unsigned paid successes are never returned.
 *
 * This module exports a web-standard handler (Request -> Response) via
 * createPaidMcpHandler, which mounts as a Vercel function or inside Hono.
 */

import { createPaidMcpHandler } from 'x402-mcp'
import { createFacilitatorConfig } from '@coinbase/x402'
import { z } from 'zod'

import { config, assertConfigured } from './config.js'
import {
  screenAddress,
  buildAttribution as sanctionsAttribution,
} from './chainalysis.js'
import {
  checkCompany,
  buildAttribution as companyAttribution,
  CompanyNotFoundError,
} from './companiesHouse.js'
import {
  checkUSCompany,
  buildAttribution as usCompanyAttribution,
  USCompanyNotFoundError,
} from './secEdgar.js'
import {
  screenName,
  buildOfacAttribution,
  OfacUpstreamError,
} from './ofac.js'
import { attest } from './attest.js'
import { preflightPayment, inspectPayment } from './preflight.js'
import { INSPECT_DESCRIPTION } from './inspectRoute.js'
import { getReceiptById, verifyReceipt, VerifyReceiptInputError } from './receiptTools.js'

// Fail fast if misconfigured — same discipline as the HTTP API.
assertConfigured()

// D2.3 (Task 9): x402-mcp's paidTool() embeds this description verbatim into
// paymentRequirements.description, sent to the SAME CDP hosted facilitator
// as the HTTP x402 routes (see src/discovery.ts's MAX_X402_DESCRIPTION_LENGTH
// comment) — and that facilitator's /verify rejects any payload whose
// resource.description exceeds 500 characters, AFTER the buyer has already
// signed (x402-foundation/x402#2832). Confirmed by reading x402-mcp's own
// server.js: it builds paymentRequirements.description from this exact
// string. Four of these six tool descriptions were over that limit before
// D2.3 (screen_wallet 567, verify_uk_company 484, verify_us_company 574,
// preflight_payment 786) — the same class of bug that broke the HTTP
// preflight route in D2.2B1, just never exercised via this transport yet.
// See test/mcpToolDescriptions.ts for the regression test.
export const MAX_MCP_TOOL_DESCRIPTION_LENGTH = 480

export const SCREEN_WALLET_DESCRIPTION =
  'Sanctions-screen an EVM wallet address against the Chainalysis on-chain oracle ' +
  '(OFAC SDN, EU, UN designations). Reflects current status, including delistings -- ' +
  'a once-designated address may now screen clean. Returns a sanctioned / ' +
  'not-sanctioned boolean (no case-level detail). Call before sending USDC or other ' +
  'funds to an address, for AML compliance and counterparty due diligence.'

export const SCREEN_NAME_DESCRIPTION =
  'OFAC name screening: fuzzy-match a person or company name against the ' +
  'official US Treasury OFAC Specially Designated Nationals (SDN) list ' +
  '(primary names + strong aliases). Returns scored candidate matches ' +
  'with the matched name, SDN type, and program. SCOPE: this is a ' +
  'screening aid for AML / KYC / sanctions compliance — a match is a ' +
  'candidate to investigate with secondary identifiers (DOB, ' +
  'nationality, ID), NOT a determination. Weak AKAs are not screened, ' +
  'per OFAC guidance.'

export const VERIFY_UK_COMPANY_DESCRIPTION =
  'UK company KYB lookup via the official Companies House register. Given a UK ' +
  'registration number, returns legal status (active/dissolved), company type, ' +
  'incorporation date, registered office, and people with significant control ' +
  '(PSC / beneficial owners). Call to confirm a UK business is real, active, and ' +
  'who controls it, for KYB onboarding and counterparty due diligence. Authoritative ' +
  'UK government data.'

export const VERIFY_US_COMPANY_DESCRIPTION =
  'US public company verification via SEC EDGAR. Given a ticker, CIK, or company ' +
  'name, returns entity name, CIK, industry (SIC), state of incorporation, ' +
  'exchanges/tickers, address, and latest SEC filing. Ambiguous names return ' +
  'candidates, never a silent selection. Covers SEC-registered PUBLIC companies and ' +
  'funds only -- not private US companies. Call for KYB and counterparty due ' +
  'diligence on listed US entities.'

export const DILIGENCE_TOOL_DESCRIPTION =
  'Combined counterparty due diligence in one call: runs sanctions ' +
  'screening on a crypto wallet (Chainalysis oracle — OFAC SDN, EU, ' +
  'UN) AND a UK Companies House KYB lookup (status, type, PSC / ' +
  'beneficial owners) in parallel. Built for compliance agents vetting ' +
  'a counterparty that has both an on-chain wallet and a UK company. ' +
  'Returns both independent results, plus an explicit disclaimer that ' +
  'no verified link between the wallet and the company is established ' +
  'by the data.'

// D2.3 (Task 9): task-oriented per the milestone's own example wording --
// when to call, required input, structured output, and what OCD does NOT
// authorize. Shortened from 786 chars (see MAX_MCP_TOOL_DESCRIPTION_LENGTH
// above) while preserving every one of those points.
export const PREFLIGHT_PAYMENT_TOOL_DESCRIPTION =
  'Call BEFORE an agent authorizes an autonomous payment. Evaluates it against your ' +
  'policy (max amount, allowed networks/assets, expected recipient, allowed origins) ' +
  'and returns a signed PREFLIGHT receipt -- ALLOW, REQUIRE_APPROVAL, or BLOCK, with ' +
  'reasons -- independently verifiable by anyone. Policy evaluation only: OCD never ' +
  'holds, moves, or authorizes funds. The wallet/x402 client separately authorizes ' +
  'execution after; ALLOW does not guarantee it will proceed.'

// D2.5 (Section 7): deferred from D2.3 -- free, structured, reuse the exact
// converged verification contract (receiptTools.ts -> receipts.ts's
// verifyReceiptEnvelope), no new bespoke verifier logic. Task-oriented per
// Section 8's own example wording.
export const GET_RECEIPT_DESCRIPTION =
  'Look up a public OCD receipt by its exact receipt_id (format "OCD-RCP-XXXX-XXXX-XXXX-XXXX"). Free, ' +
  'no payment. Returns the complete signed receipt envelope, or a structured not-found/unavailable ' +
  'reason -- never a guess. A private (unpublished) receipt and an unknown id are indistinguishable, ' +
  'both by design: this never confirms or denies that a private receipt exists.'

export const VERIFY_RECEIPT_DESCRIPTION =
  'Independently checks whether a receipt is cryptographically VALID, INVALID, or UNVERIFIABLE, with a ' +
  'reason code. Free, no payment. Pass EITHER receipt_id (looks it up first, must be public) OR a ' +
  'complete receipt envelope you already hold (verified directly, no publication needed). This is a ' +
  'convenient ONLINE check -- it trusts this server to have honestly fetched the real signing-key ' +
  'registry. Running the same check yourself offline (the published @onchaindiligence/agent-evidence ' +
  'package) is a strictly stronger trust position; this tool does not replace that option.'

// Coinbase facilitator (verifies/settles the x402 USDC payment on Base) built
// from CDP keys. This is what makes the payment non-custodial and accountless.
const facilitator = createFacilitatorConfig(
  config.x402.cdpKeyId,
  config.x402.cdpKeySecret
)

/**
 * Build the paid MCP handler. Five paidTools, each priced, each running the
 * same check the HTTP API runs and returning the same shape + honest attribution.
 */
export const handler = createPaidMcpHandler(
  (server) => {
    // --- screen_wallet -------------------------------------------------
    server.paidTool(
      'screen_wallet',
      SCREEN_WALLET_DESCRIPTION,
      { price: config.prices.screen },
      { address: z.string().describe('EVM wallet address (0x + 40 hex) to sanctions-screen') },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const result = await screenAddress(args.address)
          const envelope = await attest({ ...result, ...sanctionsAttribution() })
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope, null, 2) },
            ],
          }
        } catch (err: any) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  err?.message ||
                  'Sanctions screen failed. The oracle RPC may be temporarily unreachable.',
              },
            ],
          }
        }
      }
    )

    // --- screen_name ---------------------------------------------------
    server.paidTool(
      'screen_name',
      SCREEN_NAME_DESCRIPTION,
      { price: config.prices.nameScreen },
      {
        name: z
          .string()
          .describe('Person or company name to screen against the OFAC SDN list'),
        threshold: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe(
            'Optional match confidence cutoff 0.5–1.0 (default 0.85). Lower = ' +
              'more candidates, more false positives.'
          ),
      },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const result = await screenName(args.name, args.threshold ?? 0.85)
          const envelope = await attest({ ...result, ...buildOfacAttribution() })
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope, null, 2) },
            ],
          }
        } catch (err: any) {
          const msg =
            err instanceof OfacUpstreamError
              ? 'OFAC SDN list is temporarily unavailable, please retry shortly.'
              : err?.message || 'Name screen failed.'
          return { isError: true, content: [{ type: 'text', text: msg }] }
        }
      }
    )

    // --- verify_uk_company ---------------------------------------------
    server.paidTool(
      'verify_uk_company',
      VERIFY_UK_COMPANY_DESCRIPTION,
      { price: config.prices.company },
      {
        companyNumber: z
          .string()
          .describe('UK Companies House registration number to verify, e.g. 00000006'),
      },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const result = await checkCompany(args.companyNumber)
          const envelope = await attest({ ...result, ...companyAttribution() })
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope, null, 2) },
            ],
          }
        } catch (err: any) {
          const msg =
            err instanceof CompanyNotFoundError
              ? err.message
              : err?.message || 'Company lookup failed.'
          return { isError: true, content: [{ type: 'text', text: msg }] }
        }
      }
    )

    // --- verify_us_company ---------------------------------------------
    server.paidTool(
      'verify_us_company',
      VERIFY_US_COMPANY_DESCRIPTION,
      { price: config.prices.usCompany },
      {
        query: z
          .string()
          .describe(
            'US public company ticker, SEC CIK, or company name — e.g. ' +
              '"AAPL", "0000320193", or "Apple Inc"'
          ),
      },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const result = await checkUSCompany(args.query)
          const envelope = await attest({ ...result, ...usCompanyAttribution() })
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope, null, 2) },
            ],
          }
        } catch (err: any) {
          const msg =
            err instanceof USCompanyNotFoundError
              ? err.message
              : err?.message || 'US company lookup failed.'
          return { isError: true, content: [{ type: 'text', text: msg }] }
        }
      }
    )

    // --- diligence (combined) ------------------------------------------
    server.paidTool(
      'diligence',
      DILIGENCE_TOOL_DESCRIPTION,
      { price: config.prices.diligence },
      {
        wallet: z.string().describe('EVM wallet address (0x + 40 hex) to sanctions-screen'),
        company: z.string().describe('UK Companies House registration number to verify'),
      },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const [wallet, company] = await Promise.all([
            screenAddress(args.wallet),
            checkCompany(args.company),
          ])
          const envelope = await attest({
            wallet_check: { ...wallet, ...sanctionsAttribution() },
            company_check: { ...company, ...companyAttribution() },
            link_disclaimer:
              'These are independent checks against separate data sources. ' +
              'No verified link between the wallet and the company is ' +
              'established by this data, regardless of the individual results.',
          })
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope, null, 2) },
            ],
          }
        } catch (err: any) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: err?.message || 'Combined diligence failed.',
              },
            ],
          }
        }
      }
    )

    // --- preflight_payment (D2.1) ---------------------------------------
    server.paidTool(
      'preflight_payment',
      PREFLIGHT_PAYMENT_TOOL_DESCRIPTION,
      { price: config.prices.preflight },
      {
        action: z.object({
          kind: z.literal('PAYMENT').describe('The only supported action kind in v1.'),
          resource: z
            .string()
            .nullable()
            .optional()
            .describe('URL of the resource/service the payment is for, if any.'),
          network: z.string().describe('CAIP-2 network identifier, e.g. "eip155:8453" for Base mainnet.'),
          asset: z.string().describe('Canonical ERC-20 token contract address (0x…) — never a ticker like "USDC".'),
          amount: z.string().describe('Canonical decimal string amount, e.g. "1.00". Never a float.'),
          sender: z.string().nullable().optional().describe('Sender wallet address, if known.'),
          recipient: z.string().describe('Recipient wallet address (0x…).'),
        }),
        policy: z.object({
          max_amount: z
            .string()
            .nullable()
            .optional()
            .describe('Maximum allowed decimal amount, or null for no configured cap.'),
          allowed_networks: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('Allowed CAIP-2 networks, or null for no restriction.'),
          allowed_assets: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('Allowed token contract addresses, or null for no restriction.'),
          expected_recipient: z
            .string()
            .nullable()
            .optional()
            .describe('Exact recipient address the caller expects, or null.'),
          allowed_resource_origins: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('Allowed https origins for action.resource, or null.'),
          acknowledge_unconstrained: z
            .boolean()
            .optional()
            .describe('Required (true) if every constraint above is null/omitted, confirming that was intentional and not an accident.'),
          expected_payer: z
            .string()
            .nullable()
            .optional()
            .describe('Frozen commitment to the wallet expected to authorize the eventual on-chain payment (D2.4 binding strength) — decision-neutral, or null.'),
        }),
        options: z
          .object({
            screen_recipient_sanctions: z
              .boolean()
              .optional()
              .describe('If true, screen the recipient wallet against the Chainalysis sanctions oracle.'),
          })
          .optional(),
        references: z
          .object({
            mandate_digest: z
              .string()
              .nullable()
              .optional()
              .describe('Optional sha256:… digest of a private mandate this proposal was derived from.'),
          })
          .optional(),
      },
      { readOnlyHint: true, openWorldHint: true },
      async (args) => {
        try {
          const result = await preflightPayment(args)
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: err?.message || 'Preflight evaluation failed.' }],
          }
        }
      }
    )

    // --- inspect_payment (D2.1A) -- FREE, no payment wrapper ------------
    // Deliberately server.tool(), not server.paidTool(): this must never
    // require an x402 payment, or agents would need to pay to decide
    // whether preflight_payment's paid evidence is worth paying for.
    server.tool(
      'inspect_payment',
      INSPECT_DESCRIPTION,
      {
        action: z.object({
          kind: z.literal('PAYMENT').describe('The only supported action kind in v1.'),
          resource: z.string().nullable().optional().describe('URL of the resource/service the payment is for, if any.'),
          network: z.string().describe('CAIP-2 network identifier, e.g. "eip155:8453" for Base mainnet.'),
          asset: z.string().describe('Canonical ERC-20 token contract address (0x…) — never a ticker like "USDC".'),
          amount: z.string().describe('Canonical decimal string amount, e.g. "1.00". Never a float.'),
          sender: z.string().nullable().optional().describe('Sender wallet address, if known.'),
          recipient: z.string().describe('Recipient wallet address (0x…).'),
        }),
        policy: z.object({
          max_amount: z.string().nullable().optional().describe('Maximum allowed decimal amount, or null for no configured cap.'),
          allowed_networks: z.array(z.string()).nullable().optional().describe('Allowed CAIP-2 networks, or null for no restriction.'),
          allowed_assets: z.array(z.string()).nullable().optional().describe('Allowed token contract addresses, or null for no restriction.'),
          expected_recipient: z.string().nullable().optional().describe('Exact recipient address the caller expects, or null.'),
          allowed_resource_origins: z.array(z.string()).nullable().optional().describe('Allowed https origins for action.resource, or null.'),
          acknowledge_unconstrained: z
            .boolean()
            .optional()
            .describe('Required (true) if every constraint above is null/omitted, confirming that was intentional and not an accident.'),
          expected_payer: z
            .string()
            .nullable()
            .optional()
            .describe('Frozen commitment to the wallet expected to authorize the eventual on-chain payment (D2.4 binding strength) — decision-neutral, or null.'),
        }),
      },
      { readOnlyHint: true, openWorldHint: false },
      async (args) => {
        try {
          const result = await inspectPayment(args)
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err: any) {
          return {
            isError: true,
            content: [{ type: 'text', text: err?.message || 'Inspection failed.' }],
          }
        }
      }
    )

    // --- get_receipt (D2.5, deferred from D2.3) -- FREE, no payment wrapper ---
    server.tool(
      'get_receipt',
      GET_RECEIPT_DESCRIPTION,
      { receipt_id: z.string().describe('Exact receipt id, e.g. "OCD-RCP-EMG6-6KR4-PQSG-MZPQ".') },
      { readOnlyHint: true, openWorldHint: false },
      async ({ receipt_id }) => {
        const result = await getReceiptById(receipt_id)
        if (!result.found) {
          return { content: [{ type: 'text', text: JSON.stringify({ found: false, reason: result.reason }, null, 2) }] }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.envelope, null, 2) }] }
      }
    )

    // --- verify_receipt (D2.5, deferred from D2.3) -- FREE, no payment wrapper ---
    server.tool(
      'verify_receipt',
      VERIFY_RECEIPT_DESCRIPTION,
      {
        receipt_id: z.string().optional().describe('Look up and verify a public receipt by exact id. Mutually exclusive with envelope.'),
        envelope: z
          .unknown()
          .optional()
          .describe('A complete receipt envelope you already hold ({schema, receipt, proof}) to verify directly. Mutually exclusive with receipt_id.'),
      },
      { readOnlyHint: true, openWorldHint: false },
      async (args) => {
        try {
          const result = await verifyReceipt(args)
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err: any) {
          if (err instanceof VerifyReceiptInputError) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          return { isError: true, content: [{ type: 'text', text: err?.message || 'Verification failed.' }] }
        }
      }
    )
  },
  // serverOptions (mcp-handler) — keep defaults.
  {},
  // payment + transport config
  {
    recipient: config.x402.recipient,
    // `@coinbase/x402` builds its FacilitatorConfig against @x402/core@2.x while
    // `x402-mcp` types against x402@0.5.x — same runtime shape ({url,
    // createAuthHeaders}) but TS treats them as distinct types. Cast at this
    // single boundary; verified compatible by the package internals.
    facilitator: facilitator as any,
    network: config.x402.network,
  }
)
