/**
 * index.ts — Vercel entrypoint (and the app definition).
 *
 * Vercel's Node runtime detects a default-exported Hono app as a server
 * entrypoint and turns it into a Function automatically. The same app is used
 * locally by src/local.ts (which imports `app` and calls serve()).
 *
 * Routes:
 *   GET  /                              liveness
 *   GET  /openapi.json                  free: OpenAPI 3.1 for the x402 HTTP API
 *   GET  /.well-known/x402              free: x402 capability manifest
 *   ALL  /mcp                           the x402-paid MCP handler (Streamable HTTP)
 *   GET  /x402/screen/:address          paid: wallet sanctions screen
 *   GET  /x402/screen-name              paid: OFAC name screen
 *   GET  /x402/uk-company/:companyNumber paid: UK Companies House KYB
 *   GET  /x402/us-company               paid: SEC EDGAR company verification
 *   GET  /x402/diligence                paid: combined wallet + UK company
 *   GET  /x402/verdict/:address         paid: PASS / WARN / BLOCK verdict
 *   POST /x402/preflight-payment        paid: structured payment policy preflight (D2.1)
 *   POST /inspect/payment               free: unsigned deterministic policy inspection (D2.1A)
 *   GET  /receipts/:receiptId           free: public receipt resolver (D2.0A, durable+bundled D2.2)
 *   GET  /public/activity               free: read-only usage_events aggregates for /live
 *   POST /receipts/finalize             free (capability-protected): Commerce Receipt finalization (D2.2)
 *   POST /operations                    free: create a durable operation (D2.4)
 *   GET  /operations/:operationId       free (recovery-credential-protected): operation status (D2.4)
 *   POST /x402/lifecycle/preflight-payment  paid: operation-bound, resumable preflight (D2.4)
 */
// OPS-V2: must import first. ESM evaluates each import's module graph fully,
// in declaration order, before the next import even begins -- this guarantees
// the global fetch timeout wrapper and unhandled-rejection guard are installed
// before src/server.js and src/discovery.js's module-scope facilitator setup
// (including discovery.js's eager, unawaited x402ResourceServer.initialize())
// ever runs. See facilitatorResilience.ts's header for the full root cause.
import './src/facilitatorResilience.js'
import { Hono } from 'hono'
import { handler } from './src/server.js'
import { mountPublicMcp } from './src/publicMcp.js'
import { mountPublicActivity } from './src/activity.js'
import { mountDiscovery } from './src/discovery.js'
import { mountPublicMetadata } from './src/publicMetadata.js'
import { mountReceipts } from './src/receiptsRoute.js'
import { mountInspect } from './src/inspectRoute.js'
import { mountVerifyReceipt } from './src/receiptToolsRoute.js'
import { mountFinalize } from './src/finalizeRoute.js'
import { mountLifecycle, mountLifecyclePreflightHandler } from './src/lifecycleRoute.js'
import { mountLifecycleFinalize } from './src/lifecycleFinalizeRoute.js'
import { mountAccountHistory } from './src/accountHistoryRoute.js'
import { mountSavedReceipts } from './src/savedReceiptsRoute.js'
import { mountWebhooks } from './src/webhookRoute.js'
import { mountMerchantEvidence } from './src/merchantEvidenceRoute.js'
import { mountProviderEvidence } from './src/providerEvidenceRoute.js'
import { mountTurnkeyWebhook } from './src/turnkeyWebhookRoute.js'
import { mountCrossmintWebhook } from './src/crossmintWebhookRoute.js'
import { mountCircleWebhook } from './src/circleWebhookRoute.js'
import { mountWorkspace } from './src/workspaceRoute.js'
import { mountDashboardCors } from './src/dashboardCors.js'
import { mountAllowanceRoutes } from './src/allowanceRoute.js'
import { mountSwapRoutes } from './src/swapRoute.js'
import { mountBridgeRoutes } from './src/bridgeRoute.js'
import { mountStakingRoutes } from './src/stakingRoute.js'
import { attestationReady, canonicalVerdictReady } from './src/attest.js'
import { outcomeForStatus, readMcpEnvelope, recordEvent } from './src/telemetry.js'

const app = new Hono()
app.get('/', (c) => c.text('OnchainDiligence MCP server — POST /mcp'))

// Browser-only CORS for the authenticated Dashboard account surface. This is
// deliberately mounted before those routes and nowhere else: it answers
// preflight before API-key auth without changing public, MCP, x402, or payment
// route behavior. See src/dashboardCors.ts.
mountDashboardCors(app)

// D2.10C: separate free surface, outside paid/readiness/telemetry middleware.
mountPublicMcp(app)
// Read-only public aggregates of usage_events for onchaindiligence.com/live.
mountPublicActivity(app)

// Free, unauthenticated discovery documents: GET /openapi.json and
// GET /.well-known/x402. Mounted before the paid middleware; neither path
// matches /x402/* so neither is ever payment-gated.
mountPublicMetadata(app)

const requireSigningReadiness = async (c: any, next: () => Promise<void>) => {
  if (!(await attestationReady())) {
    c.header('Retry-After', '10')
    return c.json(
      {
        error: 'attestation service temporarily unavailable',
        detail: 'No payment was requested. Retry when signing readiness is restored.',
      },
      503
    )
  }
  await next()
}

const requireCanonicalVerdictReadiness = async (c: any, next: () => Promise<void>) => {
  if (!(await canonicalVerdictReady())) {
    c.header('Retry-After', '10')
    return c.json(
      {
        error: 'canonical verdict service temporarily unavailable',
        detail: 'No payment was requested. Retry when verdict readiness is restored.',
      },
      503
    )
  }
  await next()
}

/**
 * Aggregate funnel counter for the HTTP x402 rail. Records the matched ROUTE
 * TEMPLATE only — never c.req.path, which embeds caller input such as the
 * screened address or company number. No query string, headers or body is
 * read here. See src/telemetry.ts for the full field allowlist.
 */
const recordHttpFunnel = async (c: any, next: () => Promise<void>) => {
  await next()
  const status = c.res?.status ?? 0
  recordEvent('http.request', {
    route: c.req.routePath ?? 'unknown',
    status,
    outcome: outcomeForStatus(status),
  })
}

// OPS-V2: mcp-handler@1.1.0's Streamable HTTP dispatch only implements GET
// (405), DELETE (405), and POST for /mcp -- HEAD and OPTIONS match none of
// its branches and fall through with no response ever written, which hangs
// the request until the platform's ~300s function timeout. This is
// registered FIRST, before requireSigningReadiness (which itself makes a
// network call to check attestation-service health), so HEAD/OPTIONS /mcp
// terminate here deterministically without ANY outbound network call --
// not just the facilitator's -- and never reach the x402/payment handler.
app.use('/mcp', async (c, next) => {
  // Content-Length: 0 is set explicitly -- without it, a zero-body non-204
  // response leaves body framing ambiguous over HTTP/1.1 keep-alive, which
  // was observed hanging real clients (curl) against the deployed Preview
  // even though this handler itself returned instantly (confirmed via
  // Vercel response headers arriving immediately, framing was the only gap).
  if (c.req.method === 'OPTIONS') return c.body(null, 204, { Allow: 'POST', 'Content-Length': '0' })
  if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'POST', 'Content-Length': '0' })
  await next()
})

// Registered before either payment implementation so a signing outage fails
// before x402 verification/settlement can collect funds.
app.use('/x402/*', recordHttpFunnel)
app.use('/mcp', requireSigningReadiness)
app.use('/x402/*', requireSigningReadiness)
app.use('/allowances/observe', requireSigningReadiness)
app.use('/swaps/observe', requireSigningReadiness)
app.use('/bridges/observe', requireSigningReadiness)
app.use('/stakes/observe', requireSigningReadiness)
app.use('/x402/verdict/:address', requireCanonicalVerdictReadiness)

/**
 * MCP transport. The funnel needs to distinguish connection attempts from
 * browsing (`tools/list`) from paid intent (`tools/call`), which requires the
 * JSON-RPC method name. Only the method and the static tool name are read —
 * arguments are never touched — from a CLONE, so the original body stream
 * still reaches the handler untouched. Any failure here is swallowed: the
 * paid path must never break because telemetry could not parse something.
 * Tagged `surface: 'paid'` so this and the free /public/mcp surface (see
 * src/publicMcp.ts) are distinguishable in the same event stream. Per-tool
 * outcome (`mcp.tool_result`) is recorded separately, inside src/server.ts,
 * where the actual tool callbacks are available. client identity
 * (`mcp.session`) is recorded HERE, from the same cloned body, rather than
 * from the paid McpServer instance after handling: mcp-handler's stateless
 * POST path never exposes or closes that instance afterward, so there is no
 * reliable post-handling hook to read the SDK's own clientInfo state from
 * (see telemetry.ts's readMcpEnvelope for the full explanation).
 */
app.all('/mcp', async (c) => {
  // OPS-V2: HEAD/OPTIONS are already short-circuited above, before
  // requireSigningReadiness -- by the time a request reaches here it is
  // always GET/POST/DELETE (GET and DELETE are themselves rejected with a
  // clean 405 by the underlying mcp-handler transport).
  try {
    const envelope = readMcpEnvelope(await c.req.raw.clone().text())
    recordEvent('mcp.request', { surface: 'paid', method: envelope.method, tool: envelope.tool })
    if (envelope.clientName || envelope.clientVersion) {
      recordEvent('mcp.session', {
        surface: 'paid',
        client_name: envelope.clientName,
        client_version: envelope.clientVersion,
        transport: 'streamable-http',
      })
    }
  } catch {
    // Best-effort only.
  }
  return handler(c.req.raw)
})

// D2.4: mounts POST /operations, GET /operations/:operationId, and the
// operation-bound POST /x402/lifecycle/preflight-payment GATE ONLY.
// Registered BEFORE mountDiscovery so its gate middleware (specific path)
// runs before mountDiscovery's own `/x402/*` paymentMiddleware -- this is
// what lets a recognized retry skip payment entirely instead of attempting
// to charge twice. The TERMINAL handler for that same route is mounted
// separately, below, AFTER mountDiscovery -- see lifecycleRoute.ts's header
// for why registering it here (as this used to do) silently made the route
// free in production.
mountLifecycle(app)

// Additive: mounts GET /x402/screen/:address (paid + Bazaar-discoverable),
// and (Section 4) the broad `/x402/*` paymentMiddleware that
// /x402/lifecycle/preflight-payment's terminal handler (mounted next) relies
// on already being in place. Does not touch the /mcp handler above. Safe to
// remove by deleting this call and src/discovery.ts.
mountDiscovery(app)
// D3.6A: portable ERC-20 allowance inspection/observation. The paid
// preflight terminal route itself is mounted by discovery after its x402 gate.
mountAllowanceRoutes(app)
mountSwapRoutes(app)
mountBridgeRoutes(app)
mountStakingRoutes(app)

// D2.4: mounts the TERMINAL POST /x402/lifecycle/preflight-payment handler.
// Must be registered AFTER mountDiscovery (immediately above) so that call's
// paymentMiddleware is already in Hono's dispatch chain for this path ahead
// of this handler -- see lifecycleRoute.ts's mountLifecyclePreflightHandler().
mountLifecyclePreflightHandler(app)

// D2.0A: mounts GET /receipts/:receiptId, the public Agent Evidence receipt
// resolver. Free, unauthenticated, read-only. Safe to remove by deleting
// this call and src/receiptsRoute.ts.
mountReceipts(app)

// D2.1A: mounts POST /inspect/payment, the free unsigned deterministic
// policy inspection primitive. Deliberately outside /x402/* (no payment
// middleware — see src/inspectRoute.ts) and outside the funnel/readiness
// middleware above, which are /x402/*-scoped for exactly this reason.
mountInspect(app)

// D2.5: mounts POST /verify-receipt, the free structured verify_receipt
// primitive (GET /receipts/:receiptId, get_receipt's HTTP equivalent,
// already existed). Deliberately outside /x402/* -- see src/receiptToolsRoute.ts.
mountVerifyReceipt(app)

// D2.2: mounts POST /receipts/finalize. Free but capability-protected — see
// src/finalizeRoute.ts. Not an x402 resource: the paid preflight already
// bought this bounded post-flight capability, so a second payment here
// would recreate exactly the recursive-payment problem D2.1A was built to
// avoid on the front end.
mountFinalize(app)

// D2.4: mounts POST /operations/:operationId/execution-bindings (+ .../state)
// and POST /operations/:operationId/finalize. All additive, layered on top
// of finalizePayment() above -- see src/lifecycleFinalizeRoute.ts.
mountLifecycleFinalize(app)

// D2.7A: mounts POST /accounts, GET /me/operations, GET
// /me/operations/:operationId -- a separate, read-only, account-api-key-
// gated surface layered on top of the same D2.4 tables. Does not affect any
// route above. See src/accountHistoryRoute.ts.
mountAccountHistory(app)
mountSavedReceipts(app)
mountWorkspace(app)

// D2.7B: mounts POST/GET /me/webhooks, DELETE /me/webhooks/:id, GET
// /me/webhooks/:id/deliveries, and the internal POST
// /internal/webhooks/deliver a Vercel Cron hits to drive retries. See
// src/webhookRoute.ts.
mountWebhooks(app)

// D2.9A: mounts POST /operations/:operationId/merchant-evidence
// (recovery-credential-gated, same auth as the D2.4 execution-binding
// routes above). See src/merchantEvidenceRoute.ts.
mountMerchantEvidence(app)

// D3.4C1: captures a normalized x402/executor provider claim under the
// operation recovery credential. It is append-only provider-reported evidence,
// never a replacement for independently observed settlement.
mountProviderEvidence(app)

// D3.4C3: POST /webhooks/turnkey/transaction-status -- inbound, Ed25519-
// signature-verified Turnkey transaction-status evidence. Correlated to an
// operation ONLY via the durable execution_bindings.provider_reference the
// executor itself established; never trusts an operation id from Turnkey.
// See src/turnkeyWebhookRoute.ts.
mountTurnkeyWebhook(app)

// D3.4C4: POST /webhooks/crossmint/transfer -- inbound, Svix-signature-
// verified Crossmint wallet-transfer evidence. Correlated to an operation
// ONLY via the durable execution_bindings.provider_reference the executor
// itself established; never trusts an operation id from Crossmint.
// See src/crossmintWebhookRoute.ts.
mountCrossmintWebhook(app)

// D3.4C6: POST /webhooks/circle/transaction-status -- inbound, ECDSA-
// signature-verified Circle v2 wallet-transaction evidence. Correlated to
// an operation ONLY via the durable execution_bindings.provider_reference
// the executor itself established; never trusts an operation id from
// Circle. See src/circleWebhookRoute.ts.
mountCircleWebhook(app)

export default app
