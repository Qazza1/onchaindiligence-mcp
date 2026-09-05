/** D2.3 (Task 9): every paidTool() description must stay under the CDP
 * facilitator's resource.description limit -- x402-mcp's paidTool()
 * forwards the description verbatim into paymentRequirements.description,
 * sent to the SAME CDP hosted facilitator as the HTTP x402 routes (see
 * src/discovery.ts's own regression test, test/x402Routes.ts). Four of
 * these six tool descriptions were over the limit before this fix
 * (screen_wallet 567, verify_uk_company 484, verify_us_company 574,
 * preflight_payment 786) -- the exact class of bug that broke the HTTP
 * preflight route in D2.2B1, just not yet exercised via this transport.
 *
 * Run with: npx tsx test/mcpToolDescriptions.ts
 *
 * Fully offline: only measures string constants, never touches the network
 * or the facilitator.
 */
import assert from 'node:assert/strict'

process.env.COMPANIES_HOUSE_API_KEY = 'test-companies-house-key'
process.env.X402_RECIPIENT_ADDRESS = '0x63c347d7e42b940e79AfEC3D172bFc2921b6c897'
process.env.X402_NETWORK = 'base'
process.env.CDP_API_KEY_ID = 'test-cdp-key-id'
process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret'
process.env.ATTESTATION_SERVICE_TOKEN = 'test-service-token-that-is-at-least-32-chars'

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in offline test: ${String(input)}`)
}) as typeof fetch

const {
  MAX_MCP_TOOL_DESCRIPTION_LENGTH,
  SCREEN_WALLET_DESCRIPTION,
  SCREEN_NAME_DESCRIPTION,
  VERIFY_UK_COMPANY_DESCRIPTION,
  VERIFY_US_COMPANY_DESCRIPTION,
  DILIGENCE_TOOL_DESCRIPTION,
  PREFLIGHT_PAYMENT_TOOL_DESCRIPTION,
} = await import('../src/server.js')

const CDP_FACILITATOR_HARD_LIMIT = 500
assert.ok(MAX_MCP_TOOL_DESCRIPTION_LENGTH < CDP_FACILITATOR_HARD_LIMIT)

const descriptions: Record<string, string> = {
  screen_wallet: SCREEN_WALLET_DESCRIPTION,
  screen_name: SCREEN_NAME_DESCRIPTION,
  verify_uk_company: VERIFY_UK_COMPANY_DESCRIPTION,
  verify_us_company: VERIFY_US_COMPANY_DESCRIPTION,
  diligence: DILIGENCE_TOOL_DESCRIPTION,
  preflight_payment: PREFLIGHT_PAYMENT_TOOL_DESCRIPTION,
}

for (const [tool, description] of Object.entries(descriptions)) {
  assert.ok(
    description.length <= MAX_MCP_TOOL_DESCRIPTION_LENGTH,
    `${tool} description is ${description.length} chars, over the ${MAX_MCP_TOOL_DESCRIPTION_LENGTH}-char safety margin (facilitator hard limit ${CDP_FACILITATOR_HARD_LIMIT})`
  )
}
console.log(
  `ok  every MCP paidTool description is <= ${MAX_MCP_TOOL_DESCRIPTION_LENGTH} chars: ` +
    Object.entries(descriptions).map(([tool, d]) => `${tool}=${d.length}`).join(', ')
)

// The task-oriented rewrite must still say what OCD does NOT authorize.
assert.match(PREFLIGHT_PAYMENT_TOOL_DESCRIPTION, /never holds, moves, or authorizes funds/)
assert.match(PREFLIGHT_PAYMENT_TOOL_DESCRIPTION, /does not guarantee it will proceed/)
console.log('ok  preflight_payment description still states what OCD does NOT authorize')

console.log('\nAll D2.3 MCP tool description tests passed.')
