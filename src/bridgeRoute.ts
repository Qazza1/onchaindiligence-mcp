/** Small public/MCP transport surface for portable Circle CCTP V2 bridge evidence (D3.6C). */
import type { Hono } from 'hono'
import { evaluateBridgePolicy, parseBridgeInput, BridgeInputError } from './bridge.js'
import { observeBridgeDestination, observeBridgeSource } from './bridgeObservation.js'
import { signBridgeObservation, signBridgePreflight, verifyBridgeArtifact, type BridgePreflightArtifact } from './bridgeEvidence.js'

export const INSPECT_BRIDGE_DESCRIPTION =
  'FREE. Deterministically inspect a narrow Circle CCTP V2 Base-to-Ethereum native-USDC bridge request against explicit policy. No wallet action, no signing, no chain read.'
export const PREFLIGHT_BRIDGE_DESCRIPTION =
  'Call BEFORE an agent asks its wallet to bridge Base USDC to Ethereum via Circle CCTP V2 (depositForBurn). OCD evaluates strict policy and returns a signed portable bridge artifact. ALLOW is policy only, never wallet authority.'
export const OBSERVE_BRIDGE_DESCRIPTION =
  'Given a signed OCD bridge preflight artifact, the Base depositForBurn transaction hash, and (once available) the Ethereum receiveMessage transaction hash, independently observe both chains, verify the CCTP message identity matches, and reconcile against the authorized action. Source-only observation is reported as an evidence gap, never as completion.'

export async function inspectBridge(raw: unknown) {
  const input = parseBridgeInput(raw)
  const evaluated = evaluateBridgePolicy(input)
  return { ...evaluated, action: input.action, policy: input.policy, artifact: null }
}

export async function preflightBridge(raw: unknown) {
  const input = parseBridgeInput(raw)
  const evaluated = evaluateBridgePolicy(input)
  const artifact = await signBridgePreflight({ ...evaluated, action: input.action, policy: input.policy })
  return { ...evaluated, artifact }
}

export async function observeBridge(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BridgeInputError('body must be an object')
  const input = raw as Record<string, unknown>
  if (typeof input.source_transaction_hash !== 'string' || !input.artifact) throw new BridgeInputError('body must contain artifact and source_transaction_hash')
  if (input.destination_transaction_hash !== undefined && typeof input.destination_transaction_hash !== 'string') throw new BridgeInputError('destination_transaction_hash must be a string when provided')
  const verification = await verifyBridgeArtifact(input.artifact)
  if (verification.state !== 'VALID') throw new BridgeInputError(`preflight artifact is not verifiable: ${verification.code}`)
  const preflight = (input.artifact as { data: BridgePreflightArtifact }).data
  if (preflight.artifact_type !== 'PREFLIGHT') throw new BridgeInputError('artifact must be a PREFLIGHT bridge artifact')
  const source = await observeBridgeSource(input.source_transaction_hash)
  const destination = input.destination_transaction_hash ? await observeBridgeDestination(input.destination_transaction_hash) : null
  return { artifact: await signBridgeObservation(preflight, source, destination) }
}

export function mountBridgeRoutes(app: Hono): void {
  app.post('/inspect/bridge', async (c) => {
    try { return c.json(await inspectBridge(await c.req.json()), 200) } catch (err: any) {
      return c.json({ error: err?.message || 'bridge inspection failed' }, err instanceof BridgeInputError ? 400 : 502)
    }
  })
  app.post('/bridges/observe', async (c) => {
    try { return c.json(await observeBridge(await c.req.json()), 200) } catch (err: any) {
      return c.json({ error: err?.message || 'bridge observation failed' }, err instanceof BridgeInputError ? 400 : 502)
    }
  })
  app.post('/verify-bridge-action', async (c) => {
    try { return c.json(await verifyBridgeArtifact(await c.req.json()), 200) } catch { return c.json({ state: 'INVALID', code: 'body-invalid', message: 'body must be JSON' }, 400) }
  })
}
