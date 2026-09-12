/** Public HTTP/MCP transport for portable Lido stETH submit evidence. */
import type { Hono } from 'hono'
import { evaluateStakingPolicy, parseStakingInput, StakingInputError } from './staking.js'
import { observeLidoStaking } from './stakingObservation.js'
import { signStakingObservation, signStakingPreflight, verifyStakingArtifact, type StakingPreflightArtifact } from './stakingEvidence.js'

export const INSPECT_STAKING_DESCRIPTION = 'FREE. Deterministically inspect a narrow Ethereum Lido stETH submit request against explicit policy. No wallet action, signing, or chain read.'
export const PREFLIGHT_STAKING_DESCRIPTION = 'Call BEFORE an agent asks its wallet to submit ETH to Lido stETH. OCD evaluates strict policy and returns a signed portable staking artifact. ALLOW is policy only, never wallet authority.'
export const OBSERVE_STAKING_DESCRIPTION = 'Given a signed OCD staking preflight artifact and Ethereum transaction hash, independently inspect the canonical Lido Submitted event, transaction sender/value, optional minted shares, and Ethereum finalized-head finality. OCD never stakes ETH.'

export async function inspectStaking(raw: unknown) { const input = parseStakingInput(raw), evaluated = evaluateStakingPolicy(input); return { ...evaluated, action: input.action, policy: input.policy, artifact: null } }
export async function preflightStaking(raw: unknown) { const input = parseStakingInput(raw), evaluated = evaluateStakingPolicy(input); return { ...evaluated, artifact: await signStakingPreflight({ ...evaluated, action: input.action, policy: input.policy }) } }
export async function observeStaking(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StakingInputError('body must be an object')
  const input = raw as Record<string, unknown>
  if (typeof input.transaction_hash !== 'string' || !input.artifact) throw new StakingInputError('body must contain artifact and transaction_hash')
  const verification = await verifyStakingArtifact(input.artifact)
  if (verification.state !== 'VALID') throw new StakingInputError(`preflight artifact is not verifiable: ${verification.code}`)
  const preflight = (input.artifact as { data: StakingPreflightArtifact }).data
  if (preflight.artifact_type !== 'PREFLIGHT') throw new StakingInputError('artifact must be a PREFLIGHT staking artifact')
  return { artifact: await signStakingObservation(preflight, await observeLidoStaking(input.transaction_hash)) }
}
export function mountStakingRoutes(app: Hono): void {
  const response = (handler: (body: unknown) => Promise<unknown>) => async (c: any) => { try { return c.json(await handler(await c.req.json()), 200) } catch (error: any) { return c.json({ error: error?.message || 'staking request failed' }, error instanceof StakingInputError ? 400 : 502) } }
  app.post('/inspect/staking', response(inspectStaking))
  app.post('/stakes/observe', response(observeStaking))
  app.post('/verify-staking-action', async (c) => { try { return c.json(await verifyStakingArtifact(await c.req.json()), 200) } catch { return c.json({ state: 'INVALID', code: 'body-invalid', message: 'body must be JSON' }, 400) } })
}
