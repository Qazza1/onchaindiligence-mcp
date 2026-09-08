/**
 * Browser CORS boundary for the authenticated Dashboard account surface.
 *
 * This is intentionally mounted only on /accounts and /me/* in index.ts.
 * It does not grant browser access to public, MCP, x402, lifecycle, or
 * payment routes, and authentication remains entirely route-owned.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono'

export const DASHBOARD_ORIGIN = 'https://app.onchaindiligence.com'
export const DASHBOARD_CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'
export const DASHBOARD_CORS_HEADERS = 'Authorization, Content-Type'

const dashboardCors: MiddlewareHandler = async (c: Context, next) => {
  // Do not reflect arbitrary origins. Requests without the exact production
  // Dashboard origin continue through without any browser-granting headers.
  if (c.req.header('origin') !== DASHBOARD_ORIGIN) {
    await next()
    return
  }

  c.header('Access-Control-Allow-Origin', DASHBOARD_ORIGIN)
  c.header('Vary', 'Origin')

  // Preflight must complete before the account API-key authentication used by
  // the real handlers. No credentialed CORS mode is enabled.
  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Methods', DASHBOARD_CORS_METHODS)
    c.header('Access-Control-Allow-Headers', DASHBOARD_CORS_HEADERS)
    c.header('Access-Control-Max-Age', '86400')
    return c.body(null, 204)
  }

  await next()
}

/** Mount the one shared, intentionally narrow Dashboard browser boundary. */
export function mountDashboardCors(app: Hono): void {
  app.use('/accounts', dashboardCors)
  app.use('/me/*', dashboardCors)
}
