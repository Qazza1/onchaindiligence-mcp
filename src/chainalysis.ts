/**
 * chainalysis.ts
 * --------------
 * Sanctions screening via the **Chainalysis on-chain sanctions oracle** —
 * a public smart contract, NOT the HTTP API.
 *
 * WHY THE ORACLE (and not the HTTP API):
 * Chainalysis publishes the same US/EU/UN sanctions data two ways: a gated
 * HTTP API that requires a requested API key, and an on-chain oracle smart
 * contract that — in Chainalysis's own words — "is available for anyone to
 * use and does not require a customer relationship with Chainalysis." We use
 * the oracle so the service needs no API key, no signup, and no approval.
 * Same data, same source, zero gatekeeping.
 *
 * HOW IT WORKS:
 * The oracle exposes `isSanctioned(address) -> bool`. We do a read-only
 * (eth_call) against the oracle contract on Ethereum mainnet via a public
 * RPC. A read call costs no gas and broadcasts nothing. The oracle is NOT
 * deployed on Tempo, which is why we read it on Ethereum — this is fully
 * independent of where the *payment* settles (the agent still pays on Tempo
 * in server.ts / mcp.ts; only this lookup reads Ethereum).
 *
 * LICENSING POSTURE (unchanged intent):
 * The oracle is a free public good. The fee charged in server.ts is a flat
 * infrastructure/anti-spam cost, not a markup on sanctions data. Nothing is
 * cached or persisted — every screen is a fresh on-chain read. Every result
 * carries explicit attribution (buildAttribution() below).
 *
 * IMPORTANT — what the oracle does and doesn't return:
 * The oracle answers a single boolean: is this address sanctioned? It does
 * NOT return the rich per-match detail (names, programs, list URLs) that the
 * HTTP API did. We therefore keep the SanctionsResult shape stable for
 * callers, but when an address IS sanctioned we return ONE honest, generic
 * identification entry rather than inventing specifics the oracle never gave
 * us. We never fabricate match details.
 */

import { createPublicClient, http, getAddress, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { config } from './config.js'

export interface SanctionsIdentification {
  category: string
  name: string
  description: string
  url?: string
}

export interface SanctionsResult {
  address: string
  sanctioned: boolean
  identifications: SanctionsIdentification[]
}

/**
 * Kept for interface compatibility with callers/tests. The oracle path does
 * not rate-limit per key the way the HTTP API did, but server.ts still maps
 * any upstream trouble through these, and tests reference them.
 */
export class ChainalysisRateLimitError extends Error {
  constructor() {
    super('Sanctions oracle RPC rate limit hit')
    this.name = 'ChainalysisRateLimitError'
  }
}

export class ChainalysisUpstreamError extends Error {
  constructor(public status: number) {
    super(`Sanctions oracle read failed (status ${status})`)
    this.name = 'ChainalysisUpstreamError'
  }
}

// Minimal ABI — only the read method we need.
const SANCTIONS_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'isSanctioned',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Lazily-built viem client so importing this module never opens a socket
// (keeps tests and the MCP stdio boot clean).
let client: ReturnType<typeof createPublicClient> | null = null
function getClient() {
  if (!client) {
    client = createPublicClient({
      chain: mainnet,
      transport: http(config.sanctionsOracle.rpcUrl),
    })
  }
  return client
}

/**
 * Screens a single address against the Chainalysis sanctions oracle.
 * Always live — a fresh on-chain read every time, never cached.
 *
 * Throws on a malformed address (so callers return a clean 400) and wraps
 * RPC/transport failures in ChainalysisUpstreamError (so server.ts can turn
 * them into a 502/health-gated response rather than a 500).
 */
export async function screenAddress(address: string): Promise<SanctionsResult> {
  // Validate + checksum. getAddress throws if it isn't a valid EVM address;
  // we convert that into our typed upstream-style error with a 400 marker so
  // the route layer treats it as bad input, not an outage.
  let checksummed: Address
  try {
    checksummed = getAddress(address)
  } catch {
    // 400-class: bad address. Distinct from an upstream failure.
    const err = new ChainalysisUpstreamError(400)
    err.message = `"${address}" is not a valid EVM address`
    throw err
  }

  let sanctioned: boolean
  try {
    sanctioned = (await getClient().readContract({
      address: config.sanctionsOracle.contractAddress as Address,
      abi: SANCTIONS_ABI,
      functionName: 'isSanctioned',
      args: [checksummed],
    })) as boolean
  } catch (err) {
    // Any RPC/network failure → upstream error (502-class). The health gate
    // and the no-auto-refund policy cover this path.
    throw new ChainalysisUpstreamError(502)
  }

  // The oracle gives only a boolean. Keep the result shape stable, but do not
  // fabricate match specifics the oracle didn't provide.
  const identifications: SanctionsIdentification[] = sanctioned
    ? [
        {
          category: 'sanctioned',
          name: 'Sanctioned address',
          description:
            'Address is present on the Chainalysis on-chain sanctions oracle, ' +
            'which reflects US/EU/UN sanctions designations. The oracle returns ' +
            'a match flag only; consult official OFAC/EU/UN sources for the ' +
            'specific designation details.',
          url: 'https://www.chainalysis.com/free-cryptocurrency-sanctions-screening-tools/',
        },
      ]
    : []

  return {
    address: checksummed,
    sanctioned,
    identifications,
  }
}

/**
 * Standard attribution block. Every response that includes oracle data MUST
 * include this — it keeps the product honest about what it is (a free-tool
 * wrapper, not an independent compliance product).
 */
export function buildAttribution() {
  return {
    source: 'Chainalysis on-chain sanctions oracle (free public good, no API key)',
    method: `read-only isSanctioned() call on Ethereum mainnet oracle ${config.sanctionsOracle.contractAddress}`,
    note:
      'This fee covers infrastructure only, not the underlying data. The oracle ' +
      'reflects US/EU/UN sanctions lists and returns a match flag; it is not ' +
      'legal advice and is not a complete compliance program.',
  }
}
