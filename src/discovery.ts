/**
 * discovery.ts — CDP Bazaar discovery route (additive; Path A).
 * ------------------------------------------------------------------
 * A standalone x402-paid route that mirrors the `screen_wallet` check, built
 * on the @x402 v2 resource-server stack WITH the Bazaar discovery extension —
 * so the CDP Facilitator indexes it after the first successful settle.
 *
 * This is deliberately SEPARATE from the /mcp handler, which keeps using
 * `x402-mcp` untouched. Nothing here changes the live MCP server; if the
 * Bazaar experiment goes nowhere, delete this file and the three lines in
 * index.ts and the server is exactly as it was.
 *
 * It reuses your real wiring: the same CDP facilitator creds, the same Base
 * recipient, and the same `screenAddress()` from chainalysis.ts.
 *
 * Network is CAIP-2 (eip155:8453 = Base mainnet, eip155:84532 = Base Sepolia),
 * derived from config.x402.network so it follows the same X402_NETWORK env as
 * the rest of the server. START ON base-sepolia: the one settle needed to
 * trigger indexing then costs free testnet USDC, not real money.
 */
import type { Hono } from 'hono'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { declareDiscoveryExtension } from '@x402/extensions/bazaar'
import { createFacilitatorConfig } from '@coinbase/x402'

import { config } from './config.js'
import { screenAddress, buildAttribution } from './chainalysis.js'
import { checkUSCompany, buildAttribution as buildEdgarAttribution } from './secEdgar.js'

// Network for THIS beacon, decoupled from the live /mcp server. Defaults to
// the same network as the rest of the server, but X402_DISCOVERY_NETWORK can
// override it — so the beacon can sit on free base-sepolia for the trigger
// settle while /mcp stays on Base mainnet. (Flipping X402_NETWORK alone would
// move the production MCP server too, which we don't want.)
const DISCOVERY_NETWORK = process.env.X402_DISCOVERY_NETWORK || config.x402.network
const CAIP2 = DISCOVERY_NETWORK === 'base' ? 'eip155:8453' : 'eip155:84532'

// CDP facilitator (verify + settle on Base), reusing the SAME creds the /mcp
// handler uses. Built purely from args — touches no global state.
const facilitatorClient = new HTTPFacilitatorClient(
  createFacilitatorConfig(config.x402.cdpKeyId, config.x402.cdpKeySecret)
)

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  CAIP2,
  new ExactEvmScheme()
)

// Keyword-rich description — this is what agents search on in the Bazaar.
const DESCRIPTION =
  'Sanctions-screen an EVM wallet address against the Chainalysis on-chain ' +
  'oracle (OFAC, EU, UN designated addresses). Returns a clear sanctioned / ' +
  'not-sanctioned result. For AML compliance, counterparty due diligence, ' +
  'and payment screening before sending funds.'

// Keyword-rich description for the US company verification beacon.
const US_COMPANY_DESCRIPTION =
  'Verify a US public company against SEC EDGAR. Look up an SEC-registered ' +
  'issuer by ticker, CIK, or name and get its legal entity name, industry ' +
  '(SIC), state of incorporation, tickers/exchanges, and latest filing. For ' +
  'KYB, counterparty due diligence, and issuer verification.'

/**
 * Mounts the paid + discoverable /x402/screen/:address route onto the given
 * Hono app. The payment middleware is route-scoped (only this path is gated),
 * so / and /mcp pass straight through. Middleware is registered before the
 * handler, as Hono requires.
 */
export function mountDiscovery(app: Hono): void {
  app.use(
    paymentMiddleware(
      {
        'GET /x402/screen/:address': {
          accepts: {
            scheme: 'exact',
            price: '$0.01',
            network: CAIP2,
            payTo: config.x402.recipient,
          },
          description: DESCRIPTION,
          mimeType: 'application/json',
          // --- Bazaar discovery metadata -------------------------------
          // This block is the whole point: it's what makes CDP index the
          // route. If `tsc` flags the shape against the installed
          // @x402/extensions types, paste the error — this is the one bit
          // most likely to need a version-specific tweak.
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  address: '0x0000000000000000000000000000000000000000',
                  sanctioned: false,
                  identifications: [],
                },
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    sanctioned: { type: 'boolean' },
                    identifications: { type: 'array' },
                  },
                },
              },
            }),
          },
        },
        // Second Bazaar route: US public company verification (SEC EDGAR).
        'GET /x402/us-company': {
          accepts: {
            scheme: 'exact',
            price: '$0.05',
            network: CAIP2,
            payTo: config.x402.recipient,
          },
          description: US_COMPANY_DESCRIPTION,
          mimeType: 'application/json',
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  source: 'SEC EDGAR',
                  cik: '0000320193',
                  name: 'Apple Inc.',
                  entity_type: 'operating',
                  sic_description: 'Electronic Computers',
                  state_of_incorporation: 'CA',
                  tickers: ['AAPL'],
                  exchanges: ['Nasdaq'],
                },
                schema: {
                  type: 'object',
                  properties: {
                    source: { type: 'string' },
                    cik: { type: 'string' },
                    name: { type: 'string' },
                    entity_type: { type: 'string' },
                    sic_description: { type: 'string' },
                    state_of_incorporation: { type: 'string' },
                    tickers: { type: 'array' },
                    exchanges: { type: 'array' },
                  },
                },
              },
            }),
          },
        },
      },
      resourceServer
    )
  )

  // Paid handler — only runs after payment verifies and settles.
  app.get('/x402/screen/:address', async (c) => {
    const address = c.req.param('address')
    try {
      const result = await screenAddress(address)
      return c.json({ ...result, ...buildAttribution() })
    } catch (err: any) {
      const msg = err?.message || 'sanctions screen failed'
      const status = /not a valid/i.test(msg) ? 400 : 502
      return c.json({ error: msg }, status)
    }
  })

  // Paid handler for US company verification. Query via ?q= (ticker, CIK, or
  // name), mirroring the HTTP API's /us-company route.
  app.get('/x402/us-company', async (c) => {
    const query = c.req.query('q')
    if (!query) {
      return c.json({ error: 'provide ?q= (a ticker, CIK, or company name)' }, 400)
    }
    try {
      const result = await checkUSCompany(query)
      return c.json({ ...result, ...buildEdgarAttribution() })
    } catch (err: any) {
      const msg = err?.message || 'US company lookup failed'
      // Not-found is a normal, informative result — surface it as 404, not 502.
      const status = /not found|not an sec/i.test(msg) ? 404 : 502
      return c.json({ error: msg }, status)
    }
  })
}
