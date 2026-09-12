/**
 * facilitatorResilience.ts — OPS-V2.
 *
 * Bounds the x402 CDP facilitator's network calls and prevents an unhandled
 * rejection from crashing the whole process during a facilitator outage.
 *
 * ROOT CAUSE (confirmed by reading the installed package sources, not
 * guessed):
 *
 *   1. `x402/verify`'s `useFacilitator()` (used by x402-mcp's paid tools on
 *      POST /mcp) and `@x402/core`'s `x402ResourceServer.initialize()` (used
 *      by discovery.ts's `/x402/*` paymentMiddleware) both call the CDP
 *      facilitator with a plain `fetch(...)` and NO timeout of any kind. A
 *      facilitator outage (401, socket error, or a request that never
 *      resolves) can therefore hang the calling request until the
 *      platform's own function timeout (~300s).
 *
 *   2. `@x402/hono`'s `paymentMiddleware(routes, resourceServer)` defaults
 *      `syncFacilitatorOnStart` to `true`, which fires
 *      `httpServer.initialize()` EAGERLY at module load (see discovery.ts's
 *      `app.use('/x402/*', paymentMiddleware(...))`) without ever awaiting
 *      or attaching a `.catch()` to that promise. If the facilitator is
 *      unreachable, that promise rejects with nothing to observe it -- an
 *      unhandled promise rejection, which Node's default
 *      `--unhandled-rejections=throw` behavior (Node >=15) turns into a
 *      process crash, taking down any other in-flight request on the same
 *      warm serverless instance (including unrelated /mcp traffic).
 *
 * Neither package exposes a per-call timeout or a custom-fetch injection
 * point in its public config shape, and this file does not edit anything
 * under node_modules. Both facilitator code paths do share one thing we DO
 * control: they both end up calling the platform's global `fetch` against
 * the CDP facilitator's fixed base URL. Wrapping global `fetch`, scoped
 * strictly to that URL prefix, bounds both call sites from this one place
 * without touching any other fetch call in the app (RPC clients, Companies
 * House, SEC EDGAR, Circle, the attestation service, etc. are untouched).
 */

/** Coinbase's fixed x402 facilitator base URL (@coinbase/x402's own constant). */
export const CDP_FACILITATOR_URL_PREFIX = 'https://api.cdp.coinbase.com/platform/v2/x402'

/**
 * Conservative bound for facilitator capability/bootstrap and verify/settle
 * calls: a few seconds, not the platform's full ~300s function timeout. Long
 * enough for a healthy facilitator's normal latency, short enough that a
 * hung request fails fast instead of holding a serverless invocation open.
 */
export const FACILITATOR_TIMEOUT_MS = 5_000

export class FacilitatorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`facilitator request timed out after ${timeoutMs}ms`)
    this.name = 'FacilitatorTimeoutError'
  }
}

/**
 * Wraps a fetch implementation so any request whose URL starts with
 * `urlPrefix` is bounded by `timeoutMs`, aborting the underlying request and
 * rejecting with `FacilitatorTimeoutError`. Every other request passes
 * through to `fetchImpl` completely unchanged. Pure and independently
 * testable -- no global state.
 */
export function wrapFetchWithFacilitatorTimeout(
  fetchImpl: typeof fetch,
  urlPrefix: string,
  timeoutMs: number
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith(urlPrefix)) {
      return fetchImpl(input, init)
    }

    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new FacilitatorTimeoutError(timeoutMs)), timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutController.signal]) : timeoutController.signal

    try {
      return await fetchImpl(input, { ...init, signal })
    } catch (err) {
      if (timeoutController.signal.aborted) throw new FacilitatorTimeoutError(timeoutMs)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }) as typeof fetch
}

let globalFetchInstalled = false

/** Idempotent: installs the bounded-fetch wrapper on `globalThis.fetch` once. */
export function installFacilitatorFetchTimeout(): void {
  if (globalFetchInstalled) return
  globalFetchInstalled = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = wrapFetchWithFacilitatorTimeout(original, CDP_FACILITATOR_URL_PREFIX, FACILITATOR_TIMEOUT_MS)
}

/** Test-only seam: undoes installFacilitatorFetchTimeout()'s global patch. */
export function __resetFacilitatorFetchTimeoutForTests(original: typeof fetch): void {
  globalFetchInstalled = false
  globalThis.fetch = original
}

let unhandledRejectionGuardInstalled = false

/**
 * Idempotent: keeps a facilitator-outage-triggered unhandled rejection (see
 * this file's header, cause #2) from crashing the process. Logs for
 * visibility; never rethrows. This is a narrow, process-wide safety net --
 * appropriate here because the promise it protects against is one this
 * codebase never receives a handle to (it lives inside @x402/hono's
 * closure), not a general license to swallow bugs silently.
 */
export function installUnhandledRejectionGuard(): void {
  if (unhandledRejectionGuardInstalled) return
  unhandledRejectionGuardInstalled = true
  process.on('unhandledRejection', (reason) => {
    console.error('[ops-v2] unhandled rejection kept the process alive (see facilitatorResilience.ts):', reason)
  })
}

installFacilitatorFetchTimeout()
installUnhandledRejectionGuard()
