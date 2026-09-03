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

// Fail fast if misconfigured — same discipline as the HTTP API.
assertConfigured()

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
      'Sanctions screening for a crypto wallet address. Checks an EVM ' +
        'address against the Chainalysis on-chain sanctions oracle, which ' +
        'covers OFAC SDN, EU, and UN designated addresses. The oracle ' +
        'reflects designations as they stand today, including removals — ' +
        'an address that was once designated may screen clean if it has ' +
        'since been delisted. Returns a clear sanctioned / not-sanctioned ' +
        'boolean; the oracle does not return programme-level case detail. Use for AML compliance, ' +
        'counterparty due diligence, and payment screening before sending ' +
        'USDC or any funds to an address.',
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
      'OFAC name screening: fuzzy-match a person or company name against the ' +
        'official US Treasury OFAC Specially Designated Nationals (SDN) list ' +
        '(primary names + strong aliases). Returns scored candidate matches ' +
        'with the matched name, SDN type, and program. SCOPE: this is a ' +
        'screening aid for AML / KYC / sanctions compliance — a match is a ' +
        'candidate to investigate with secondary identifiers (DOB, ' +
        'nationality, ID), NOT a determination. Weak AKAs are not screened, ' +
        'per OFAC guidance.',
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
      'UK company verification and KYB (know-your-business) lookup via the ' +
        'official Companies House register. Given a UK company registration ' +
        'number, returns legal status (active / dissolved), company type, ' +
        'incorporation date, registered office address, and the people with ' +
        'significant control (PSC / beneficial owners). Use for KYB ' +
        'onboarding, supplier and counterparty due diligence, and confirming ' +
        'a UK business is real, active, and who controls it. Authoritative ' +
        'UK government open data.',
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
      'US public company verification via the SEC EDGAR system. Given a ' +
        'ticker, SEC CIK, or company name, returns the registered entity ' +
        'name, CIK, industry (SIC code), state of incorporation, listed ' +
        'exchanges and tickers, business address, and most recent SEC ' +
        'filing. Ambiguous name searches return candidates and never silently ' +
        'select a company. SCOPE: EDGAR covers SEC-registered PUBLIC companies and ' +
        'funds only — NOT private US companies, which register at the state ' +
        'level. Use for KYB and counterparty due diligence on listed US ' +
        'entities. Authoritative US government open data.',
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
      'Combined counterparty due diligence in one call: runs sanctions ' +
        'screening on a crypto wallet (Chainalysis oracle — OFAC SDN, EU, ' +
        'UN) AND a UK Companies House KYB lookup (status, type, PSC / ' +
        'beneficial owners) in parallel. Built for compliance agents vetting ' +
        'a counterparty that has both an on-chain wallet and a UK company. ' +
        'Returns both independent results, plus an explicit disclaimer that ' +
        'no verified link between the wallet and the company is established ' +
        'by the data.',
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
      'Evaluate a proposed autonomous payment against a structured, caller-supplied ' +
        'policy and optional recipient sanctions screening, BEFORE any payment is ' +
        'executed. Returns a deterministic decision — ALLOW, REQUIRE_APPROVAL, or ' +
        'BLOCK — with reasons, plus a signed OCD PREFLIGHT receipt anyone can ' +
        'independently verify. This is a POLICY EVALUATION, not payment execution: ' +
        'OnChainDiligence never holds funds and does not authorize or submit the ' +
        'payment. The wallet, PayBox, or x402 client applies its OWN separate ' +
        'authorization after this preflight; both gates are independent and an ' +
        'ALLOW here does not guarantee the execution provider will proceed. Accepts ' +
        'only structured, deterministic policy fields in v1 — free-text ' +
        'natural-language policy (e.g. "don\'t spend too much") is not supported.',
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
