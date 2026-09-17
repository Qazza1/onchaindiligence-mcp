/**
 * telemetry.ts — privacy-safe aggregate activation funnel.
 *
 * WHAT THIS IS: one structured JSON line per event on stdout, which Vercel
 * already captures as a runtime log, PLUS a best-effort durable insert into
 * the existing Neon Postgres (usage_events, db/schema.sql) so aggregate
 * counts survive past Vercel's own log retention window. There is no
 * third-party analytics SDK, no Redis/KV, no new hosted service — the
 * database is the same one already used for receipts/operations. The
 * durable insert is attached to the invocation lifecycle via `waitUntil`
 * from `@vercel/functions` (Vercel's own first-party, platform-native
 * mechanism for exactly this "do this after the response, don't abandon it"
 * case) rather than a bare unawaited promise — see recordEvent below.
 *
 * WHAT IT ANSWERS: discovery -> intent -> payment challenge -> paid success,
 * plus which self-reported client software is connecting and whether a tool
 * call and a receipt write actually succeeded, by counting events in the log
 * drain (or querying usage_events):
 *
 *   mcp.session(surface, client_name, client_version)  self-reported client
 *   mcp.request(surface, method=initialize)             connection attempts
 *   mcp.request(surface, method=tools/list)              discovery / browsing
 *   mcp.request(surface, method=tools/call, tool=…)      paid/free intent
 *   mcp.tool_result(surface, tool, outcome)              actual tool outcome
 *   http.request                     HTTP x402 requests (unchanged)
 *   http.challenge                   402 payment challenges issued
 *   http.paid_success                verified+settled paid responses
 *   http.rejected / http.error       failures, by class
 *   receipt.created(kind, publication, surface?, network?)  durable receipt write
 *
 * WHAT IT MUST NEVER CONTAIN (enforced by construction, not by convention):
 * screened addresses, screened names, company numbers, any query string, any
 * request body, tool arguments, X-PAYMENT headers, payment authorizations,
 * attestations, signatures, keys, or tokens. Only a matched ROUTE TEMPLATE
 * (never the concrete path, which embeds caller input), a static tool name, an
 * outcome class, a status code/label, the static price/network for a route,
 * and — for mcp.session — the CALLER'S OWN SELF-REPORTED client software name
 * and version (MCP `clientInfo`, never verified, never personal data).
 *
 * If a durable counter is ever genuinely needed beyond this, the correct next
 * step is a log drain or a query against usage_events — not a new service.
 */

import { waitUntil } from '@vercel/functions'
import { recordUsageEvent } from './db.js'

/** The only fields any event may carry. Anything else is dropped. */
export interface FunnelFields {
  /** Matched route TEMPLATE, e.g. "/x402/uk-company/:companyNumber". */
  route?: string
  /** Static MCP method name, e.g. "tools/call". */
  method?: string
  /** Static tool name, e.g. "screen_wallet". Never tool arguments. */
  tool?: string
  /** Coarse outcome class: "ok" | "challenge" | "rejected" | "error". */
  outcome?: string
  /** HTTP status code, or a short free-form status label. */
  status?: number | string
  /** Static list price for the route, in USD. */
  price_usd?: number
  /** CAIP-2 network the route settles on, or the receipt's action network. */
  network?: string
  /** Which MCP endpoint: the free /public/mcp or the paid /mcp. */
  surface?: 'public' | 'paid'
  /**
   * Self-reported MCP client software identity from the `initialize`
   * handshake's `clientInfo`. Attribution only, never verified: a client can
   * set this to anything. Never personal data — it is a software name/version
   * string, not an identifier of a person or account.
   */
  client_name?: string
  client_version?: string
  /** Always "streamable-http" today; both MCP surfaces are stateless. */
  transport?: string
  /** Receipt kind: "PREFLIGHT" | "COMMERCE" | "ACTION". Never the receipt body. */
  kind?: string
  /** Receipt publication choice: "public" | "private". Never the receipt body. */
  publication?: 'public' | 'private'
}

const ALLOWED_KEYS: ReadonlySet<keyof FunnelFields> = new Set([
  'route',
  'method',
  'tool',
  'outcome',
  'status',
  'price_usd',
  'network',
  'surface',
  'client_name',
  'client_version',
  'transport',
  'kind',
  'publication',
])

/**
 * Best-effort durable insert. NEVER throws and NEVER rejects the promise it
 * returns — a telemetry write failure (missing DATABASE_URL, network error,
 * transient Postgres issue) must never surface to, delay, or alter the real
 * request/tool/payment/receipt path that is already complete by the time
 * this runs. Callers deliberately do not await this.
 */
async function persistEventBestEffort(event: string, fields: Record<string, unknown>): Promise<void> {
  try {
    await recordUsageEvent(event, fields)
  } catch {
    // Best-effort only: durable telemetry is a convenience, not a dependency.
  }
}

/**
 * Emit one funnel event. Never throws: telemetry must not be able to break a
 * paid request. Unknown fields are dropped rather than logged, so a future
 * caller cannot accidentally leak an input by adding a property. The console
 * line is written synchronously; the durable insert is fired-and-forgotten.
 */
export function recordEvent(event: string, fields: FunnelFields = {}): void {
  try {
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_KEYS.has(key as keyof FunnelFields)) continue
      if (value === undefined || value === null) continue
      safe[key] = value
    }
    // Single line, stable prefix, so a log drain can filter on it cheaply.
    console.log(`x402_funnel ${JSON.stringify({ event, ...safe })}`)
    // Attach the durable write to the invocation lifecycle via Vercel's own
    // waitUntil (not a bare fire-and-forget): the platform keeps the
    // function alive until this settles (bounded by the function's own
    // timeout), instead of racing/abandoning it against the HTTP response.
    // Outside a Vercel invocation (local dev, tests) @vercel/functions'
    // waitUntil has no request context to attach to and degrades to
    // exactly today's fire-and-forget call -- never throws, never blocks,
    // never changes response timing either way.
    waitUntil(persistEventBestEffort(event, safe))
  } catch {
    // Telemetry is best-effort by design.
  }
}

/** Classify an HTTP status into a coarse, non-identifying outcome bucket. */
export function outcomeForStatus(status: number): string {
  if (status === 402) return 'challenge'
  if (status >= 200 && status < 300) return 'ok'
  if (status >= 400 && status < 500) return 'rejected'
  return 'error'
}

/**
 * Extract ONLY the JSON-RPC method, (for tools/call) the static tool name,
 * and (for initialize) the caller's self-reported clientInfo, from an MCP
 * request body. Returns nothing else — tool/init arguments beyond clientInfo
 * are never read. Fails closed to `{}` on any parse problem.
 *
 * clientInfo is read straight from the wire message rather than from the
 * SDK's server-side state after handling: on the paid /mcp surface,
 * mcp-handler's stateless POST path never closes or exposes the per-request
 * McpServer afterward (confirmed by reading its source — only its separate,
 * unused SSE/session branch does), so there is no reliable post-handling
 * hook to read `getClientVersion()` from there. Parsing the same cloned
 * body already read for method/tool works identically on both surfaces and
 * depends on nothing but the JSON-RPC message itself.
 */
export function readMcpEnvelope(body: string): {
  method?: string
  tool?: string
  clientName?: string
  clientVersion?: string
} {
  try {
    const parsed = JSON.parse(body) as {
      method?: unknown
      params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } }
    }
    const method = typeof parsed.method === 'string' ? parsed.method : undefined
    const name = parsed.params?.name
    const tool = method === 'tools/call' && typeof name === 'string' ? name : undefined
    const clientInfo = method === 'initialize' ? parsed.params?.clientInfo : undefined
    const clientName = typeof clientInfo?.name === 'string' ? clientInfo.name : undefined
    const clientVersion = typeof clientInfo?.version === 'string' ? clientInfo.version : undefined
    return {
      ...(method ? { method } : {}),
      ...(tool ? { tool } : {}),
      ...(clientName ? { clientName } : {}),
      ...(clientVersion ? { clientVersion } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Wraps an MCP tool callback to emit `mcp.tool_result` after it actually
 * resolves or throws — never before, and never inferred merely from the
 * request being accepted. Detects failure the same way x402-mcp itself does
 * (a thrown error, or a resolved result with `isError: true`), so the
 * recorded outcome always matches what the caller actually received. Never
 * alters the callback's return value, thrown error, or timing beyond the
 * telemetry call itself; a telemetry failure here can never surface as a
 * tool failure, since `recordEvent` itself never throws.
 */
export function withToolTelemetry<A extends unknown[], R>(
  surface: 'public' | 'paid',
  tool: string,
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      const result = await fn(...args)
      const isError = !!(result && typeof result === 'object' && (result as Record<string, unknown>).isError)
      recordEvent('mcp.tool_result', { surface, tool, outcome: isError ? 'error' : 'ok' })
      return result
    } catch (err) {
      recordEvent('mcp.tool_result', { surface, tool, outcome: 'error' })
      throw err
    }
  }
}
