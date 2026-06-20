/**
 * test/client.ts — local end-to-end test of the paid MCP server.
 *
 * LOW-LEVEL client on the MCP SDK + x402/client, deliberately NOT using
 * x402-mcp's withPayment (which depends on the older ai MCP client removed in
 * ai v5). Building it by hand shows the exact x402-over-MCP mechanics:
 *   1. Call the paid tool with NO payment.
 *   2. Server replies isError + structuredContent.accepts[0] = paymentRequirements.
 *   3. Build a payment header: createPaymentHeader(account, 1, requirements).
 *   4. Re-call the tool with _meta["x402/payment"] = that header.
 *   5. Server verifies via facilitator, runs the check, settles, returns result.
 */

import 'dotenv/config'
import { privateKeyToAccount } from 'viem/accounts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createPaymentHeader } from 'x402/client'

const SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp'
const PAYER_KEY = process.env.PAYER_PRIVATE_KEY as `0x${string}` | undefined
const X402_VERSION = 1
const TEST_ADDRESS = '0x7f268357A8c2552623316e2562D90e642bB538E5'

function extractAccepts(result: any): any | null {
  const sc = result?.structuredContent
  if (sc && Array.isArray(sc.accepts) && sc.accepts.length) return sc.accepts[0]
  const text = result?.content?.find((c: any) => c.type === 'text')?.text
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed?.accepts?.length) return parsed.accepts[0]
    } catch {}
  }
  return null
}

async function main() {
  if (!PAYER_KEY) throw new Error('PAYER_PRIVATE_KEY missing from .env')
  const account = privateKeyToAccount(PAYER_KEY)
  console.log('Payer:  ', account.address)
  console.log('Server: ', SERVER_URL)
  console.log('---')

  const client = new Client(
    { name: 'onchaindiligence-test-client', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)))

  const tools = await client.listTools()
  console.log('Discovered tools:', tools.tools.map((t) => t.name).join(', '))
  console.log('---')

  console.log('1) Calling screen_wallet WITHOUT payment (expect requirements)...')
  const unpaid = await client.callTool({
    name: 'screen_wallet',
    arguments: { address: TEST_ADDRESS },
  })
  const requirements = extractAccepts(unpaid)
  if (!requirements) {
    console.log('Unexpected response:', JSON.stringify(unpaid, null, 2))
    throw new Error('No payment requirements returned')
  }
  console.log(`   Requirements: ${requirements.maxAmountRequired} atomic of ${requirements.asset}`)
  console.log(`   to ${requirements.payTo} on ${requirements.network}`)

  console.log('2) Building payment header (signs a USDC authorization)...')
  const paymentHeader = await createPaymentHeader(account as any, X402_VERSION, requirements)

  console.log('3) Re-calling WITH payment...')
  const paid = await client.callTool({
    name: 'screen_wallet',
    arguments: { address: TEST_ADDRESS },
    _meta: { 'x402/payment': paymentHeader },
  })

  console.log('--- RESULT ---')
  const text = (paid as any)?.content?.find((c: any) => c.type === 'text')?.text
  console.log(text || JSON.stringify(paid, null, 2))

  await client.close()
  console.log('--- done ---')
}

main().catch((e) => {
  console.error('TEST FAILED:', e?.message || e)
  process.exit(1)
})
