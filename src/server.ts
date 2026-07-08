/**
 * server.ts — the x402-paid MCP server.
 *
 * Exposes three compliance checks as MCP tools that agents can call and PAY FOR
 * over Streamable HTTP using x402 (USDC on Base). Each tool runs the exact same
 * check logic as the HTTP API (reused chainalysis.ts / companiesHouse.ts), so an
 * agent calling via MCP gets identical results to one calling the HTTP API.
 *
 * Payment model: NON-CUSTODIAL. The x402 facilitator verifies the agent's USDC
 * payment to our recipient address before the tool body runs. We never hold funds.
 *
 * SIGNING: every tool result is wrapped in the same Ed25519 attestation envelope
 * the HTTP API returns — `{ data, attestation }` — so an agent can verify at
 * /verify that the result came from us, unaltered. Signing is done by POSTing to
 * the API's free /attest route rather than holding a copy of the private key in
 * this deployment (see attest.ts). If signing is unavailable the envelope carries
 * `signed: false` with a reason, rather than failing a request the agent paid for.
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

// Fail fast if misconfigured — same discipline as the HTTP API.
assertConfigured()

// Coinbase facilitator (verifies/settles the x402 USDC payment on Base) built
// from CDP keys. This is what makes the payment non-custodial and accountless.
const facilitator = createFacilitatorConfig(
  config.x402.cdpKeyId,
  config.x402.cdpKeySecret
)

/**
 * Build the paid MCP handler. Three paidTools, each priced, each running the
 * same check the HTTP API runs and returning the same shape + honest attribution.
 */
export const handler = createPaidMcpHandler(
  (server) => {
    // --- screen_wallet -------------------------------------------------
    server.paidTool(
      'screen_wallet',
      'Sanctions screening for a crypto wallet address. Checks an EVM ' +
        'address against the Chainalysis on-chain sanctions oracle, which ' +
        'covers OFAC SDN, EU, and UN designated addresses (including ' +
        'Tornado Cash and other sanctioned protocols). Returns a clear ' +
        'sanctioned / not-sanctioned result with the matching program. Use ' +
        'for AML compliance, counterparty due diligence, and payment ' +
        'screening before sending USDC or any funds to an address.',
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
        'filing. SCOPE: EDGAR covers SEC-registered PUBLIC companies and ' +
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
