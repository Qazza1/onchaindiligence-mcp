/** Focused D3.1A Dashboard CORS regression checks. */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  DASHBOARD_CORS_HEADERS,
  DASHBOARD_CORS_METHODS,
  DASHBOARD_ORIGIN,
  mountDashboardCors,
} from '../src/dashboardCors.js'
import { mountAccountHistory } from '../src/accountHistoryRoute.js'

const app = () => {
  const server = new Hono()
  mountDashboardCors(server)
  mountAccountHistory(server, {
    authenticateAccount: async () => null,
  })
  return server
}

const preflight = (path: string, origin = DASHBOARD_ORIGIN) => app().request(path, {
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization, content-type',
  },
})

for (const path of ['/accounts', '/me/operations', '/me/saved-receipts', '/me/webhooks', '/me/operations/OCD-OP-example']) {
  const response = await preflight(path)
  assert.equal(response.status, 204, `${path} should answer Dashboard preflight`)
  assert.equal(response.headers.get('access-control-allow-origin'), DASHBOARD_ORIGIN)
  assert.equal(response.headers.get('vary'), 'Origin')
  assert.equal(response.headers.get('access-control-allow-methods'), DASHBOARD_CORS_METHODS)
  assert.equal(response.headers.get('access-control-allow-headers'), DASHBOARD_CORS_HEADERS)
  assert.equal(response.headers.get('access-control-allow-credentials'), null)
}

const foreign = await preflight('/me/operations', 'https://example.invalid')
assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'https://example.invalid')
assert.equal(foreign.headers.get('access-control-allow-origin'), null)

const protectedResponse = await app().request('/me/operations', {
  headers: { Origin: DASHBOARD_ORIGIN },
})
assert.equal(protectedResponse.status, 401, 'CORS must not bypass account authentication')
assert.equal(protectedResponse.headers.get('access-control-allow-origin'), DASHBOARD_ORIGIN)

console.log('D3.1A Dashboard CORS checks passed')
