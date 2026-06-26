/**
 * config.ts — MCP server configuration.
 *
 * Self-contained config for the standalone x402 MCP server. Distinct from the
 * HTTP API's config: this one has NO MPP/Tempo payment settings (the MCP server
 * settles via x402 on Base, not MPP on Tempo) and adds the x402 + Coinbase CDP
 * settings the paid MCP handler needs.
 *
 * Uses `||` (not `??`) for fallbacks so a present-but-empty env line still falls
 * back to the default — a bug we hit before with `??`.
 */

export const config = {
  // --- Sanctions oracle (on-chain, no API key) --------------------------
  // Chainalysis sanctions oracle, read on Ethereum mainnet. Same as the HTTP API.
  sanctionsOracle: {
    contractAddress:
      process.env.SANCTIONS_ORACLE_ADDRESS ||
      '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
    rpcUrl:
      process.env.SANCTIONS_ORACLE_RPC_URL ||
      'https://ethereum-rpc.publicnode.com',
  },

  // --- Companies House (free UK gov open data) --------------------------
  companiesHouse: {
    apiKey: process.env.COMPANIES_HOUSE_API_KEY || '',
    baseUrl: 'https://api.company-information.service.gov.uk',
  },

  // --- x402 payment (USDC on Base) --------------------------------------
  // NOTE: recipient here is a BASE address (receives USDC), NOT the Tempo
  // recipient the HTTP API uses. Keep them separate.
  x402: {
    recipient: (process.env.X402_RECIPIENT_ADDRESS || '') as `0x${string}`,
    network: (process.env.X402_NETWORK || 'base-sepolia') as
      | 'base'
      | 'base-sepolia',
    cdpKeyId: process.env.CDP_API_KEY_ID || '',
    cdpKeySecret: process.env.CDP_API_KEY_SECRET || '',
  },

  // --- SEC EDGAR (free US public-company data, no API key) --------------
  // SEC requires a descriptive User-Agent with contact info on every request.
  // Public-domain data; covers SEC-registered (public) companies only.
  edgar: {
    userAgent:
      process.env.EDGAR_USER_AGENT ||
      'OnchainDiligence/1.0 (support@onchaindiligence.com)',
  },

  // Per-call prices in USD (x402 settles these in USDC). Mirror the HTTP API.
  prices: {
    screen: 0.01,
    company: 0.01,
    usCompany: 0.01,
    diligence: 0.015,
  },
}

/**
 * Validate that the required config is present before the server boots with
 * payment enabled. Mirrors the HTTP API's assertConfigured() discipline.
 */
export function assertConfigured(): void {
  const missing: string[] = []
  if (!config.companiesHouse.apiKey) missing.push('COMPANIES_HOUSE_API_KEY')
  if (!config.x402.recipient) missing.push('X402_RECIPIENT_ADDRESS')
  if (!config.x402.cdpKeyId) missing.push('CDP_API_KEY_ID')
  if (!config.x402.cdpKeySecret) missing.push('CDP_API_KEY_SECRET')

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set them in your .env (local) or the hosting platform's env UI.`
    )
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(config.x402.recipient)) {
    throw new Error(
      `X402_RECIPIENT_ADDRESS ("${config.x402.recipient}") is not a valid ` +
        `0x-prefixed address (expected 0x + 40 hex chars).`
    )
  }
}
