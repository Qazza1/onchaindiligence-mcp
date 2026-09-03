/**
 * publicMetadata.ts — free, unauthenticated discovery documents.
 *
 * Two small public documents describing the PAID HTTP x402 surface:
 *
 *   GET /openapi.json      OpenAPI 3.1 description of the /x402/* resources
 *   GET /.well-known/x402  capability manifest (compatibility metadata)
 *
 * Both are free and describe only the standard HTTP x402 resources. They do
 * NOT describe the /mcp JSON-RPC transport, which is a different protocol with
 * its own discovery (`tools/list`).
 *
 * On the OpenAPI side: there is no official x402 OpenAPI extension. The x402
 * ecosystem signals payment through the Bazaar extension inside the 402
 * response and through the well-known manifest below — not through an OpenAPI
 * keyword. So this document is ordinary OpenAPI 3.1, and the payment facts
 * live in normal `description` text, a documented 402 response, and one
 * clearly vendor-namespaced `x-onchaindiligence-x402` block. That prefix is
 * deliberately OUR name, so nothing here can be mistaken for a standard field.
 *
 * On the manifest side: `/.well-known/x402` follows the envelope in the IETF
 * Internet-Draft `draft-hawkins-x402-dns-discovery` ({ x402Version, kind,
 * resources[] }). That is an active individual draft, NOT a ratified standard,
 * and it is served here as compatibility/discovery metadata for crawlers that
 * look for it — never as a claim of standards compliance. One canonical path
 * only; the `.json` spelling seen elsewhere in the wild is not duplicated.
 *
 * Prices, network and descriptions are imported from discovery.ts so these
 * documents cannot drift from what the payment middleware actually charges.
 */
import type { Hono } from 'hono'

import { config } from './config.js'
import {
  CAIP2,
  DESCRIPTION,
  DILIGENCE_DESCRIPTION,
  PREFLIGHT_DESCRIPTION,
  SCREEN_NAME_DESCRIPTION,
  UK_COMPANY_DESCRIPTION,
  US_COMPANY_DESCRIPTION,
  VERDICT_DESCRIPTION,
} from './discovery.js'
import { INSPECT_DESCRIPTION } from './inspectRoute.js'

const BASE_URL = 'https://mcp.onchaindiligence.com'

/** USDC contract per supported network, for documentation only. */
const USDC_ASSET: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
}

/** One entry per paid HTTP x402 resource. Single source for both documents. */
interface ResourceSpec {
  path: string
  /** Defaults to 'GET'. Only Payment Preflight (D2.1) uses POST so far. */
  method?: 'GET' | 'POST'
  operationId: string
  summary: string
  description: string
  priceUsd: number
  pathParam?: { name: string; description: string; example: string }
  queryParams?: Array<{
    name: string
    required: boolean
    description: string
    example?: string
    schema?: Record<string, unknown>
  }>
  /** POST routes carry their input in a JSON body instead of path/query params. */
  requestBody?: { description: string; example: Record<string, unknown>; schema: Record<string, unknown> }
  /** Defaults to SIGNED_ENVELOPE_SCHEMA. Preflight's response shape differs — see below. */
  responseSchema?: Record<string, unknown>
}

const RESOURCES: ResourceSpec[] = [
  {
    path: '/x402/screen/{address}',
    operationId: 'screenWallet',
    summary: 'Sanctions-screen an EVM wallet address',
    description: DESCRIPTION,
    priceUsd: config.prices.screen,
    pathParam: {
      name: 'address',
      description: 'EVM wallet address (0x + 40 hex characters).',
      example: '0x0000000000000000000000000000000000000000',
    },
  },
  {
    path: '/x402/screen-name',
    operationId: 'screenName',
    summary: 'Screen a person or company name against the OFAC SDN list',
    description: SCREEN_NAME_DESCRIPTION,
    priceUsd: config.prices.nameScreen,
    queryParams: [
      {
        name: 'name',
        required: true,
        description: 'Person or company name to screen (2–255 characters).',
        example: 'Example Name',
      },
      {
        name: 'threshold',
        required: false,
        description:
          'Optional match confidence cutoff between 0.5 and 1 (default 0.85). Lower returns more candidates and more false positives.',
        schema: { type: 'number', minimum: 0.5, maximum: 1, default: 0.85 },
      },
    ],
  },
  {
    path: '/x402/uk-company/{companyNumber}',
    operationId: 'verifyUkCompany',
    summary: 'Verify a UK company via Companies House',
    description: UK_COMPANY_DESCRIPTION,
    priceUsd: config.prices.company,
    pathParam: {
      name: 'companyNumber',
      description: 'UK Companies House registration number.',
      example: '00000006',
    },
  },
  {
    path: '/x402/us-company',
    operationId: 'verifyUsCompany',
    summary: 'Verify a US public company via SEC EDGAR',
    description: US_COMPANY_DESCRIPTION,
    priceUsd: config.prices.usCompany,
    queryParams: [
      {
        name: 'q',
        required: true,
        description: 'Ticker, SEC CIK, or company name.',
        example: 'AAPL',
      },
    ],
  },
  {
    path: '/x402/diligence',
    operationId: 'diligence',
    summary: 'Combined wallet sanctions screen and UK company verification',
    description: DILIGENCE_DESCRIPTION,
    priceUsd: config.prices.diligence,
    queryParams: [
      {
        name: 'wallet',
        required: true,
        description: 'EVM wallet address to sanctions-screen.',
        example: '0x0000000000000000000000000000000000000000',
      },
      {
        name: 'company',
        required: true,
        description: 'UK Companies House registration number to verify.',
        example: '00000006',
      },
    ],
  },
  {
    path: '/x402/verdict/{address}',
    operationId: 'verdict',
    summary: 'Single PASS / WARN / BLOCK counterparty verdict',
    description: VERDICT_DESCRIPTION,
    priceUsd: config.prices.screen,
    pathParam: {
      name: 'address',
      description: 'EVM wallet address or ENS name.',
      example: '0x0000000000000000000000000000000000000000',
    },
  },
  {
    path: '/x402/preflight-payment',
    method: 'POST',
    operationId: 'preflightPayment',
    summary: 'Evaluate a proposed payment against structured policy before execution',
    description: PREFLIGHT_DESCRIPTION,
    priceUsd: config.prices.preflight,
    requestBody: {
      description:
        'The proposed action, a structured deterministic policy, optional evaluation options, ' +
        'and optional references. Full field-by-field documentation: docs/PAYMENT_PREFLIGHT.md.',
      example: {
        action: {
          kind: 'PAYMENT',
          resource: 'https://service.example/api',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '1.00',
          sender: null,
          recipient: '0x000000000000000000000000000000000000dEaD',
        },
        policy: {
          max_amount: '5.00',
          allowed_networks: ['eip155:8453'],
          allowed_assets: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
          expected_recipient: null,
          allowed_resource_origins: ['https://service.example'],
        },
        options: { screen_recipient_sanctions: true },
        references: { mandate_digest: null },
      },
      schema: {
        type: 'object',
        required: ['action', 'policy'],
        properties: {
          action: {
            type: 'object',
            required: ['kind', 'network', 'asset', 'amount', 'recipient'],
            properties: {
              kind: { type: 'string', enum: ['PAYMENT'] },
              resource: { type: ['string', 'null'] },
              network: { type: 'string', description: 'CAIP-2, e.g. "eip155:8453".' },
              asset: { type: 'string', description: 'Canonical ERC-20 contract address, not a ticker.' },
              amount: { type: 'string', description: 'Canonical decimal string, e.g. "1.00". Never a float.' },
              sender: { type: ['string', 'null'] },
              recipient: { type: 'string' },
            },
          },
          policy: {
            type: 'object',
            properties: {
              max_amount: { type: ['string', 'null'] },
              allowed_networks: { type: ['array', 'null'], items: { type: 'string' } },
              allowed_assets: { type: ['array', 'null'], items: { type: 'string' } },
              expected_recipient: { type: ['string', 'null'] },
              allowed_resource_origins: { type: ['array', 'null'], items: { type: 'string' } },
            },
          },
          options: {
            type: 'object',
            properties: { screen_recipient_sanctions: { type: 'boolean' } },
          },
          references: {
            type: 'object',
            properties: { mandate_digest: { type: ['string', 'null'] } },
          },
        },
      },
    },
    responseSchema: {
      type: 'object',
      required: ['decision', 'checks', 'receipt'],
      properties: {
        decision: {
          type: 'object',
          required: ['status', 'authorized', 'reasons'],
          properties: {
            status: { type: 'string', enum: ['ALLOW', 'REQUIRE_APPROVAL', 'BLOCK', 'UNKNOWN'] },
            authorized: { type: ['boolean', 'null'] },
            reasons: { type: 'array', items: { type: 'string' } },
          },
        },
        checks: { type: 'array' },
        receipt: {
          type: 'object',
          description:
            'The complete signed onchaindiligence.public-action-receipt.v1 envelope (schema/receipt/proof). ' +
            'Independently verifiable; see https://onchaindiligence.com/receipt.',
          required: ['schema', 'receipt', 'proof'],
        },
      },
    },
  },
]

/** The signed envelope every paid route returns. */
const SIGNED_ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['data', 'attestation'],
  properties: {
    data: {
      type: 'object',
      description: 'The check result. Shape varies per resource.',
    },
    attestation: {
      type: 'object',
      description:
        'Ed25519 attestation over the exact result, verifiable at https://onchaindiligence.com/verify against the published key registry. A valid signature proves the result came from OnChainDiligence unaltered; it does not make the underlying claim objectively true.',
      properties: {
        signed: { type: 'boolean' },
        key_id: { type: 'string' },
        algorithm: { type: 'string', examples: ['ed25519'] },
        signature: { type: 'string' },
      },
    },
  },
} as const

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {}

  for (const resource of RESOURCES) {
    const parameters: Array<Record<string, unknown>> = []
    if (resource.pathParam) {
      parameters.push({
        name: resource.pathParam.name,
        in: 'path',
        required: true,
        description: resource.pathParam.description,
        schema: { type: 'string' },
        example: resource.pathParam.example,
      })
    }
    for (const query of resource.queryParams ?? []) {
      parameters.push({
        name: query.name,
        in: 'query',
        required: query.required,
        description: query.description,
        schema: query.schema ?? { type: 'string' },
        ...(query.example ? { example: query.example } : {}),
      })
    }

    const verb = (resource.method ?? 'GET').toLowerCase()
    paths[resource.path] = {
      [verb]: {
        operationId: resource.operationId,
        summary: resource.summary,
        description:
          `${resource.description}\n\n` +
          `PAID RESOURCE. This endpoint requires payment over x402 (version 2). ` +
          `An unpaid request returns HTTP 402 with the payment requirements in the ` +
          `\`Payment-Required\` response header (base64 JSON containing \`accepts\`). ` +
          `Pay the quoted amount, then repeat the request with the resulting ` +
          `\`X-PAYMENT\` header. Price: $${resource.priceUsd.toFixed(2)} USDC on ` +
          `${CAIP2}. Input is validated before any payment challenge is issued, so a ` +
          `malformed request returns 400 and is never charged.`,
        ...(parameters.length ? { parameters } : {}),
        ...(resource.requestBody
          ? {
              requestBody: {
                required: true,
                description: resource.requestBody.description,
                content: {
                  'application/json': {
                    schema: resource.requestBody.schema,
                    example: resource.requestBody.example,
                  },
                },
              },
            }
          : {}),
        responses: {
          '200': {
            description: resource.requestBody
              ? 'Paid, verified evaluation result including a complete signed receipt envelope.'
              : 'Paid, verified result wrapped in a signed attestation envelope.',
            content: { 'application/json': { schema: resource.responseSchema ?? SIGNED_ENVELOPE_SCHEMA } },
          },
          '400': {
            description:
              'Invalid input. Returned before any payment challenge — the caller is not charged.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
          '402': {
            description:
              'Payment required. The `Payment-Required` response header carries base64-encoded JSON with `x402Version`, `resource`, and an `accepts` array of payment requirements.',
            headers: {
              'Payment-Required': {
                description: 'Base64-encoded x402 v2 payment requirements.',
                schema: { type: 'string' },
              },
            },
          },
          '404': { description: 'The requested record was not found at the upstream source.' },
          '502': { description: 'An upstream data source was unavailable.' },
          '503': {
            description:
              'Signing readiness unavailable. No payment is requested; retry later.',
          },
        },
        'x-onchaindiligence-x402': {
          protocol: 'x402',
          x402Version: 2,
          scheme: 'exact',
          network: CAIP2,
          asset: USDC_ASSET[CAIP2] ?? null,
          priceUsd: resource.priceUsd,
          payTo: config.x402.recipient,
        },
      },
    }
  }

  // POST /inspect/payment (D2.1A) — FREE, and deliberately NOT part of
  // RESOURCES above: RESOURCES is the paid x402 surface, reused verbatim by
  // buildWellKnownManifest()'s x402 capability manifest, which must never
  // list a non-payable resource. Documented here, separately, with its own
  // request/response shape and no PAID-RESOURCE / 402 / x-onchaindiligence-x402
  // framing — see the explicit contrast with /x402/preflight-payment below.
  paths['/inspect/payment'] = {
    post: {
      operationId: 'inspectPayment',
      summary: 'FREE deterministic payment policy inspection (no signing, no receipt)',
      description:
        `${INSPECT_DESCRIPTION}\n\n` +
        'FREE RESOURCE. No payment, no x402 challenge, no Payment-Required header. ' +
        'Contrast with POST /x402/preflight-payment, which is $0.01 and returns a ' +
        'signed, independently-verifiable receipt.',
      requestBody: {
        required: true,
        description:
          'The proposed action and a structured deterministic policy only — no `options`, ' +
          'no `references`. `options.screen_recipient_sanctions: true` is rejected with 400 ' +
          '(sanctions screening is a paid-tier feature). Full documentation: docs/PAYMENT_PREFLIGHT.md.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['action', 'policy'],
              properties: {
                action: {
                  type: 'object',
                  required: ['kind', 'network', 'asset', 'amount', 'recipient'],
                  properties: {
                    kind: { type: 'string', enum: ['PAYMENT'] },
                    resource: { type: ['string', 'null'] },
                    network: { type: 'string', description: 'CAIP-2, e.g. "eip155:8453".' },
                    asset: { type: 'string', description: 'Canonical ERC-20 contract address, not a ticker.' },
                    amount: { type: 'string', description: 'Canonical decimal string, e.g. "1.00". Never a float.' },
                    sender: { type: ['string', 'null'] },
                    recipient: { type: 'string' },
                  },
                },
                policy: {
                  type: 'object',
                  properties: {
                    max_amount: { type: ['string', 'null'] },
                    allowed_networks: { type: ['array', 'null'], items: { type: 'string' } },
                    allowed_assets: { type: ['array', 'null'], items: { type: 'string' } },
                    expected_recipient: { type: ['string', 'null'] },
                    allowed_resource_origins: { type: ['array', 'null'], items: { type: 'string' } },
                  },
                },
              },
            },
            example: {
              action: {
                kind: 'PAYMENT',
                resource: 'https://service.example/api',
                network: 'eip155:8453',
                asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                amount: '1.00',
                sender: null,
                recipient: '0x000000000000000000000000000000000000dEaD',
              },
              policy: {
                max_amount: '5.00',
                allowed_networks: ['eip155:8453'],
                allowed_assets: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
                expected_recipient: null,
                allowed_resource_origins: ['https://service.example'],
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Free, unsigned deterministic inspection result.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision', 'checks', 'evidence', 'receipt'],
                properties: {
                  decision: {
                    type: 'object',
                    required: ['status', 'authorized', 'reasons'],
                    properties: {
                      status: { type: 'string', enum: ['ALLOW', 'REQUIRE_APPROVAL', 'BLOCK', 'UNKNOWN'] },
                      authorized: { type: ['boolean', 'null'] },
                      reasons: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  checks: { type: 'array' },
                  evidence: {
                    type: 'object',
                    required: ['external_checks_performed'],
                    properties: { external_checks_performed: { type: 'boolean', const: false } },
                  },
                  receipt: {
                    type: 'null',
                    description: 'Always null — the free endpoint signs nothing and issues no receipt.',
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid input, or options.screen_recipient_sanctions was requested (paid-tier only).',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { error: { type: 'string' } } },
            },
          },
        },
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OnChainDiligence x402 HTTP API',
      version: '1.0.0',
      description:
        'Paid compliance checks for autonomous agents, settled over x402 (USDC on Base) and returned inside an Ed25519 attestation envelope anyone can verify independently.\n\n' +
        'This document describes the standard HTTP x402 resources only. The separate Model Context Protocol server at POST /mcp exposes the same checks over JSON-RPC with its own payment transport and its own discovery via `tools/list`; it is deliberately not described here.\n\n' +
        'Payment is non-custodial: a facilitator verifies and settles the payment to the recipient address before a paid handler runs. OnChainDiligence never holds funds.',
      contact: { name: 'OnChainDiligence', url: 'https://onchaindiligence.com' },
      license: { name: 'See https://onchaindiligence.com/terms' },
    },
    servers: [{ url: BASE_URL }],
    paths,
  }
}

/**
 * Capability manifest for `/.well-known/x402`.
 *
 * Envelope follows draft-hawkins-x402-dns-discovery (an active IETF
 * Internet-Draft, not a ratified standard). `kind: "resource-server"` because
 * OnChainDiligence sells resources; it does not operate a facilitator.
 */
export function buildWellKnownManifest(): Record<string, unknown> {
  return {
    x402Version: 2,
    kind: 'resource-server',
    name: 'OnChainDiligence',
    description:
      'Paid compliance checks — wallet sanctions screening, OFAC name screening, UK and US company verification, combined diligence, and a PASS/WARN/BLOCK counterparty verdict — each returned with a verifiable Ed25519 attestation.',
    resources: RESOURCES.map((resource) => ({
      url: `${BASE_URL}${resource.path.replace(/\{(\w+)\}/g, ':$1')}`,
      method: resource.method ?? 'GET',
      description: resource.summary,
    })),
    attestation: { type: 'ed25519-envelope' },
    docs: `${BASE_URL}/openapi.json`,
    contact: 'support@onchaindiligence.com',
  }
}

/** Mounts the two free discovery documents. Neither is payment-gated. */
export function mountPublicMetadata(app: Hono): void {
  app.get('/openapi.json', (c) => c.json(buildOpenApiDocument()))
  app.get('/.well-known/x402', (c) => c.json(buildWellKnownManifest()))
}
