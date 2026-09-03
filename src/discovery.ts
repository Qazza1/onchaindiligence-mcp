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
 * SIGNING: every response is wrapped in the same Ed25519 attestation envelope
 * the HTTP API returns — `{ data, attestation }` — so a Bazaar consumer can
 * verify it at /verify without trusting us. Signing is done by POSTing to the
 * API's free /attest route rather than holding a copy of the private key here
 * (see attest.ts). NOTE: this changed the response shape of /x402/screen from
 * a flat object to the envelope, bringing it in line with every other paid
 * route in the product.
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
import { screenName, buildOfacAttribution, OfacUpstreamError } from './ofac.js'
import {
  checkCompany,
  buildAttribution as buildCompanyAttribution,
  CompanyNotFoundError,
} from './companiesHouse.js'
import { attest, canonicalVerdict, CanonicalVerdictError } from './attest.js'
import {
  isValidAddressOrEns,
  isValidEvmAddress,
  isValidUkCompanyNumber,
  isValidScreeningName,
} from './inputValidation.js'

/**
 * Price strings for the x402 middleware, derived from the SAME canonical
 * `config.prices` the MCP tools use — so a price is defined once and the two
 * payment rails can never silently drift apart. `toFixed(2)` keeps the USD
 * string exact (0.1 would otherwise render as "$0.1").
 */
export const usd = (amount: number): string => `$${amount.toFixed(2)}`

/** The route-map type `paymentMiddleware` accepts. `RoutesConfig` is internal
 * to @x402/hono, so derive it from the public function signature instead of
 * restating the shape (which would drift on upgrade). */
type X402RoutesConfig = Parameters<typeof paymentMiddleware>[0]

// Network for THIS beacon, decoupled from the live /mcp server. Defaults to
// the same network as the rest of the server, but X402_DISCOVERY_NETWORK can
// override it — so the beacon can sit on free base-sepolia for the trigger
// settle while /mcp stays on Base mainnet. (Flipping X402_NETWORK alone would
// move the production MCP server too, which we don't want.)
const DISCOVERY_NETWORK = process.env.X402_DISCOVERY_NETWORK || config.x402.network
export const CAIP2 = DISCOVERY_NETWORK === 'base' ? 'eip155:8453' : 'eip155:84532'

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
export const DESCRIPTION =
  'Sanctions-screen an EVM wallet address against the Chainalysis on-chain ' +
  'oracle (OFAC, EU, UN designated addresses). Returns a clear sanctioned / ' +
  'not-sanctioned result. For AML compliance, counterparty due diligence, ' +
  'and payment screening before sending funds.'

// Keyword-rich description for the US company verification beacon.
export const US_COMPANY_DESCRIPTION =
  'Verify a US public company against SEC EDGAR. Look up an SEC-registered ' +
  'issuer by ticker, CIK, or name and get its legal entity name, industry ' +
  '(SIC), state of incorporation, tickers/exchanges, and latest filing. For ' +
  'ambiguous names, returns candidates without selecting a company. For KYB, ' +
  'counterparty due diligence, and issuer verification.'

// Keyword-rich description for the unified verdict beacon. Agents searching
// the Bazaar want a decision they can act on, not raw data to interpret.
export const VERDICT_DESCRIPTION =
  'Get a single signed counterparty verdict — PASS, WARN, or BLOCK — for an ' +
  'EVM wallet address, with reasons. BLOCK means the address itself is sanctioned; ' +
  'WARN means direct sanctioned-counterparty exposure was found or exposure ' +
  'could not be completely evaluated; PASS means neither was found within the ' +
  'reported bounded scope. For autonomous agents deciding whether to send funds.'

// Name screening is a DIFFERENT capability from wallet screening: it matches a
// person/company NAME against a sanctions list, not an on-chain address. The
// description says "candidate matches, not a determination" because that is
// what OFAC's own guidance says a name hit is.
export const SCREEN_NAME_DESCRIPTION =
  'Screen a person or company NAME against the official US Treasury OFAC ' +
  'Specially Designated Nationals (SDN) list, matching primary names and ' +
  'strong aliases and returning scored candidate matches with the matched ' +
  'name, SDN type, and programme. A match is a candidate to investigate ' +
  'against secondary identifiers (date of birth, nationality, ID number), ' +
  'not a determination. Weak aliases are not screened, per OFAC guidance. ' +
  'This screens names, not wallet addresses.'

export const UK_COMPANY_DESCRIPTION =
  'Verify a UK company against the official Companies House register. Given a ' +
  'UK registration number, returns legal status (active / dissolved), company ' +
  'type, incorporation date, registered office address, and the people with ' +
  'significant control (PSC / beneficial owners). For KYB onboarding and ' +
  'supplier or counterparty due diligence on UK entities. Covers UK ' +
  'registered companies only.'

// The honest boundary matters more than the marketing here: this route runs
// two INDEPENDENT checks and explicitly does not link them.
export const DILIGENCE_DESCRIPTION =
  'Combined counterparty due diligence in one paid call: sanctions-screens an ' +
  'EVM wallet against the Chainalysis on-chain oracle AND verifies a UK ' +
  'company against Companies House (status, type, PSC / beneficial owners), ' +
  'returning both independent results in one signed response. These are two ' +
  'separate checks against separate sources: a result does NOT establish that ' +
  'the wallet belongs to, or is controlled by, that company. Use when vetting ' +
  'a counterparty that presents both a wallet and a UK company number.'

/**
 * The paid HTTP x402 resource map: one entry per capability, each declaring
 * its price (from the canonical config), network, recipient and Bazaar
 * discovery metadata. Exported so contract tests can assert the declared
 * price/network/recipient without needing facilitator credentials, and so
 * there is exactly one definition of what this server charges for.
 */
export const X402_ROUTES: X402RoutesConfig = {
    'GET /x402/screen/:address': {
      accepts: {
        scheme: 'exact',
        price: usd(config.prices.screen),
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
              data: {
                address: '0x0000000000000000000000000000000000000000',
                sanctioned: false,
                identifications: [],
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    sanctioned: { type: 'boolean' },
                    identifications: { type: 'array' },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
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
        price: usd(config.prices.usCompany),
        network: CAIP2,
        payTo: config.x402.recipient,
      },
      description: US_COMPANY_DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              data: {
                source: 'SEC EDGAR',
                match_status: 'resolved',
                matched_by: 'ticker',
                cik: '0000320193',
                name: 'Apple Inc.',
                entity_type: 'operating',
                sic_description: 'Electronic Computers',
                state_of_incorporation: 'CA',
                tickers: ['AAPL'],
                exchanges: ['Nasdaq'],
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    source: { type: 'string' },
                    match_status: {
                      type: 'string',
                      enum: ['resolved', 'ambiguous'],
                    },
                    matched_by: { type: 'string' },
                    cik: { type: 'string' },
                    name: { type: 'string' },
                    entity_type: { type: 'string' },
                    sic_description: { type: 'string' },
                    state_of_incorporation: { type: 'string' },
                    tickers: { type: 'array' },
                    exchanges: { type: 'array' },
                    candidate_count: { type: 'integer' },
                    candidates: { type: 'array' },
                    resolution_note: { type: 'string' },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
    },
    // Third Bazaar route: unified counterparty verdict (PASS / WARN / BLOCK).
    'GET /x402/verdict/:address': {
      accepts: {
        scheme: 'exact',
        price: usd(config.prices.screen),
        network: CAIP2,
        payTo: config.x402.recipient,
      },
      description: VERDICT_DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              data: {
                verdict: 'WARN',
                reasons: [
                  'Address is not itself sanctioned, but transacted directly with 1 sanctioned address on Tempo mainnet.',
                ],
                address: '0x0000000000000000000000000000000000000000',
                signals: {
                  sanctions: { checked: true, sanctioned: false },
                  direct_counterparty_exposure: {
                    checked: true,
                    complete: true,
                    status: 'complete',
                    sanctioned_counterparties: [
                      '0x0000000000000000000000000000000000000001',
                    ],
                  },
                },
                verdict_basis: {
                  live_signals: ['sanctions', 'direct_counterparty_exposure'],
                  not_yet_evaluated: [
                    'risk_score',
                    'mixer_exposure',
                    'wallet_age',
                    'sanctions_proximity',
                  ],
                },
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    verdict: { type: 'string', enum: ['PASS', 'WARN', 'BLOCK'] },
                    reasons: { type: 'array' },
                    address: { type: 'string' },
                    signals: { type: 'object' },
                    verdict_basis: { type: 'object' },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
    },
    // --- D1.1: HTTP x402 parity with the remaining MCP tools ---------
    // OFAC name screening. A different capability from wallet screening:
    // it matches a NAME against a sanctions list, never an address.
    'GET /x402/screen-name': {
      accepts: {
        scheme: 'exact',
        price: usd(config.prices.nameScreen),
        network: CAIP2,
        payTo: config.x402.recipient,
      },
      description: SCREEN_NAME_DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              data: {
                query: 'Example Name',
                normalized_query: 'example name',
                hit: false,
                matches: [],
                threshold: 0.85,
                retrieved_at: '2026-09-03T00:00:00.000Z',
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    normalized_query: { type: 'string' },
                    hit: { type: 'boolean' },
                    threshold: { type: 'number' },
                    retrieved_at: { type: 'string' },
                    matches: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          ent_num: { type: 'integer' },
                          matched_name: { type: 'string' },
                          matched_on: { type: 'string', enum: ['primary', 'alias'] },
                          sdn_type: { type: 'string' },
                          program: { type: 'string' },
                          score: { type: 'number' },
                        },
                      },
                    },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
    },
    // UK Companies House KYB lookup.
    'GET /x402/uk-company/:companyNumber': {
      accepts: {
        scheme: 'exact',
        price: usd(config.prices.company),
        network: CAIP2,
        payTo: config.x402.recipient,
      },
      description: UK_COMPANY_DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              data: {
                profile: {
                  companyNumber: '00000006',
                  companyName: 'EXAMPLE COMPANY LIMITED',
                  status: 'active',
                  type: 'ltd',
                  incorporatedOn: '1862-10-25',
                  registeredAddress: 'Example Street, London',
                },
                pscList: [
                  {
                    name: 'Example Person',
                    kind: 'individual-person-with-significant-control',
                    natureOfControl: ['ownership-of-shares-75-to-100-percent'],
                    notifiedOn: '2016-04-06',
                  },
                ],
                pscListTruncated: false,
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    profile: {
                      type: 'object',
                      properties: {
                        companyNumber: { type: 'string' },
                        companyName: { type: 'string' },
                        status: { type: 'string' },
                        type: { type: 'string' },
                        incorporatedOn: { type: 'string' },
                        registeredAddress: { type: 'string' },
                      },
                    },
                    pscList: { type: 'array' },
                    pscListTruncated: { type: 'boolean' },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
    },
    // Combined wallet + UK company diligence. Two INDEPENDENT checks; the
    // response carries an explicit disclaimer that no link is established.
    'GET /x402/diligence': {
      accepts: {
        scheme: 'exact',
        price: usd(config.prices.diligence),
        network: CAIP2,
        payTo: config.x402.recipient,
      },
      description: DILIGENCE_DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              data: {
                wallet_check: {
                  address: '0x0000000000000000000000000000000000000000',
                  sanctioned: false,
                  identifications: [],
                },
                company_check: {
                  profile: {
                    companyNumber: '00000006',
                    companyName: 'EXAMPLE COMPANY LIMITED',
                    status: 'active',
                    type: 'ltd',
                  },
                  pscList: [],
                  pscListTruncated: false,
                },
                link_disclaimer:
                  'These are independent checks against separate data sources. No verified link between the wallet and the company is established by this data, regardless of the individual results.',
              },
              attestation: {
                signed: true,
                key_id: 'ed25519-D8wfc7civVNG05Ds',
                algorithm: 'ed25519',
                signature: 'UN4TzBvkRsf0eGm4…ZFyElhq1Cg',
              },
            },
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    wallet_check: { type: 'object' },
                    company_check: { type: 'object' },
                    link_disclaimer: { type: 'string' },
                  },
                },
                attestation: {
                  type: 'object',
                  properties: {
                    signed: { type: 'boolean' },
                    key_id: { type: 'string' },
                    algorithm: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
    },
}

/**
 * Mounts the paid + discoverable /x402/screen/:address route onto the given
 * Hono app. The payment middleware is route-scoped (only this path is gated),
 * so / and /mcp pass straight through. Middleware is registered before the
 * handler, as Hono requires.
 */
export function mountDiscovery(app: Hono): void {
  // Reject malformed verdict identifiers before the payment middleware can
  // present a challenge. ENS-like names are accepted because the canonical API
  // resolves them; all other inputs must be 20-byte EVM addresses.
  app.use('/x402/verdict/:address', async (c, next) => {
    const input = c.req.param('address')?.trim() ?? ''
    if (!isValidAddressOrEns(input)) {
      return c.json({ error: 'invalid address or ENS name parameter' }, 400)
    }
    await next()
  })

  // Same discipline for the routes added in D1.1: reject input that cannot
  // possibly succeed BEFORE the payment middleware presents a challenge, so a
  // buyer is never charged for a request that was always going to fail.
  app.use('/x402/screen-name', async (c, next) => {
    if (!isValidScreeningName(c.req.query('name') ?? '')) {
      return c.json({ error: 'provide ?name= (2–255 characters) to screen' }, 400)
    }
    await next()
  })

  app.use('/x402/uk-company/:companyNumber', async (c, next) => {
    if (!isValidUkCompanyNumber(c.req.param('companyNumber') ?? '')) {
      return c.json({ error: 'invalid UK company number' }, 400)
    }
    await next()
  })

  app.use('/x402/diligence', async (c, next) => {
    if (!isValidEvmAddress(c.req.query('wallet') ?? '')) {
      return c.json({ error: 'provide ?wallet= as a 0x EVM address' }, 400)
    }
    if (!isValidUkCompanyNumber(c.req.query('company') ?? '')) {
      return c.json({ error: 'provide ?company= as a UK company number' }, 400)
    }
    await next()
  })

  // Scoped to /x402/* deliberately. The middleware only gates the routes in
  // X402_ROUTES, but an unscoped `app.use` still RUNS it on every request —
  // including `/`, `/mcp` and the free discovery documents — which makes those
  // paths initialise the CDP facilitator for nothing. Scoping keeps the paid
  // machinery on the paid namespace; paid behaviour is unchanged because every
  // priced route already lives under /x402/.
  app.use('/x402/*', paymentMiddleware(X402_ROUTES, resourceServer))

  // Paid handler — only runs after payment verifies and settles.
  // Every result is wrapped in the same signed envelope the HTTP API returns,
  // so a Bazaar consumer can verify it at /verify exactly as they would a
  // direct API response. See attest.ts for why signing is a network call.
  app.get('/x402/screen/:address', async (c) => {
    const address = c.req.param('address')
    try {
      const result = await screenAddress(address)
      return c.json(await attest({ ...result, ...buildAttribution() }))
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
      return c.json(await attest({ ...result, ...buildEdgarAttribution() }))
    } catch (err: any) {
      const msg = err?.message || 'US company lookup failed'
      // Not-found is a normal, informative result — surface it as 404, not 502.
      const status = /not found|not an sec/i.test(msg) ? 404 : 502
      return c.json({ error: msg }, status)
    }
  })

  // Paid handler: OFAC name screening. Mirrors the `screen_name` MCP tool —
  // same screenName() call, same attribution block, same signed envelope.
  app.get('/x402/screen-name', async (c) => {
    const name = c.req.query('name') ?? ''
    const rawThreshold = c.req.query('threshold')
    let threshold = 0.85
    if (rawThreshold !== undefined) {
      const parsed = Number(rawThreshold)
      if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1) {
        return c.json({ error: 'threshold must be a number between 0.5 and 1' }, 400)
      }
      threshold = parsed
    }
    try {
      const result = await screenName(name, threshold)
      return c.json(await attest({ ...result, ...buildOfacAttribution() }))
    } catch (err: any) {
      if (err instanceof OfacUpstreamError) {
        return c.json(
          { error: 'OFAC SDN list is temporarily unavailable, please retry shortly.' },
          502
        )
      }
      return c.json({ error: err?.message || 'name screen failed' }, 502)
    }
  })

  // Paid handler: UK Companies House KYB lookup. Mirrors `verify_uk_company`.
  app.get('/x402/uk-company/:companyNumber', async (c) => {
    try {
      const result = await checkCompany(c.req.param('companyNumber'))
      return c.json(await attest({ ...result, ...buildCompanyAttribution() }))
    } catch (err: any) {
      if (err instanceof CompanyNotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      return c.json({ error: err?.message || 'company lookup failed' }, 502)
    }
  })

  // Paid handler: combined diligence. Mirrors the `diligence` MCP tool exactly,
  // including the link disclaimer — the two checks are independent and this
  // response never asserts the wallet belongs to the company.
  app.get('/x402/diligence', async (c) => {
    try {
      const [wallet, company] = await Promise.all([
        screenAddress(c.req.query('wallet') as string),
        checkCompany(c.req.query('company') as string),
      ])
      return c.json(
        await attest({
          wallet_check: { ...wallet, ...buildAttribution() },
          company_check: { ...company, ...buildCompanyAttribution() },
          link_disclaimer:
            'These are independent checks against separate data sources. ' +
            'No verified link between the wallet and the company is ' +
            'established by this data, regardless of the individual results.',
        })
      )
    } catch (err: any) {
      if (err instanceof CompanyNotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      return c.json({ error: err?.message || 'combined diligence failed' }, 502)
    }
  })

  // Paid handler for the unified counterparty verdict.
  //
  // The HTTP API owns the decision rule and signed response. MCP delegates the
  // supplied address instead of reimplementing PASS / WARN / BLOCK locally.
  app.get('/x402/verdict/:address', async (c) => {
    const address = c.req.param('address')
    try {
      return c.json(await canonicalVerdict(address))
    } catch (err: any) {
      const msg = err?.message || 'verdict failed'
      const upstreamStatus = err instanceof CanonicalVerdictError ? err.status : 502
      const status =
        upstreamStatus === 400
          ? 400
          : upstreamStatus === 401
            ? 401
            : upstreamStatus === 429
              ? 429
              : upstreamStatus === 503
                ? 503
                : 502
      return c.json({ error: msg }, status)
    }
  })
}
