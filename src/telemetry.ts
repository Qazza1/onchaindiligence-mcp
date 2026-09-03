/**
 * telemetry.ts — privacy-safe aggregate activation funnel.
 *
 * WHAT THIS IS: one structured JSON line per event on stdout, which Vercel
 * already captures as a runtime log. That is the whole mechanism. There is no
 * database, no KV store, no third-party analytics SDK, and no new dependency —
 * deliberately. Counting how many agents reached each funnel stage does not
 * justify standing up an analytics backend inside a live payment server.
 *
 * WHAT IT ANSWERS: discovery -> intent -> payment challenge -> paid success,
 * by counting events in the log drain:
 *
 *   mcp.request(method=initialize)   connection attempts
 *   mcp.request(method=tools/list)   discovery / browsing
 *   mcp.request(method=tools/call)   paid intent (outcome says whether it paid)
 *   http.request                     HTTP x402 requests
 *   http.challenge                   402 payment challenges issued
 *   http.paid_success                verified+settled paid responses
 *   http.rejected / http.error       failures, by class
 *
 * WHAT IT MUST NEVER CONTAIN (enforced by construction, not by convention):
 * screened addresses, screened names, company numbers, any query string, any
 * request body, X-PAYMENT headers, payment authorizations, attestations,
 * signatures, keys, or tokens. Only a matched ROUTE TEMPLATE (never the
 * concrete path, which embeds caller input), a static tool name, an outcome
 * class, a status code, and the static price/network for that route.
 *
 * If a durable counter is ever genuinely needed, the correct next step is a
 * log drain aggregating these lines — not writing state from this process.
 */

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
  /** HTTP status code. */
  status?: number
  /** Static list price for the route, in USD. */
  price_usd?: number
  /** CAIP-2 network the route settles on. */
  network?: string
}

const ALLOWED_KEYS: ReadonlySet<keyof FunnelFields> = new Set([
  'route',
  'method',
  'tool',
  'outcome',
  'status',
  'price_usd',
  'network',
])

/**
 * Emit one funnel event. Never throws: telemetry must not be able to break a
 * paid request. Unknown fields are dropped rather than logged, so a future
 * caller cannot accidentally leak an input by adding a property.
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
 * Extract ONLY the JSON-RPC method and (for tools/call) the static tool name
 * from an MCP request body. Returns nothing else — arguments are never read.
 * Fails closed to `{}` on any parse problem.
 */
export function readMcpEnvelope(body: string): { method?: string; tool?: string } {
  try {
    const parsed = JSON.parse(body) as {
      method?: unknown
      params?: { name?: unknown }
    }
    const method = typeof parsed.method === 'string' ? parsed.method : undefined
    const name = parsed.params?.name
    const tool = method === 'tools/call' && typeof name === 'string' ? name : undefined
    return { ...(method ? { method } : {}), ...(tool ? { tool } : {}) }
  } catch {
    return {}
  }
}
