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
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ...result, ...sanctionsAttribution() },
                  null,
                  2
                ),
              },
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
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ...result, ...companyAttribution() },
                  null,
                  2
                ),
              },
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
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    wallet_check: { ...wallet, ...sanctionsAttribution() },
                    company_check: { ...company, ...companyAttribution() },
                    link_disclaimer:
                      'These are independent checks against separate data sources. ' +
                      'No verified link between the wallet and the company is ' +
                      'established by this data, regardless of the individual results.',
                  },
                  null,
                  2
                ),
              },
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
