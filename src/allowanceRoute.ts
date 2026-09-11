/** Small public/MCP transport surface for portable ERC-20 allowance evidence. */
import type { Hono } from 'hono'
import { evaluateAllowancePolicy, parseAllowanceInput, AllowanceInputError } from './allowance.js'
import { observeAllowanceApproval, observeCurrentAllowance } from './allowanceObservation.js'
import { signAllowanceObservation, signAllowancePreflight, verifyAllowanceArtifact, type AllowancePreflightArtifact } from './allowanceEvidence.js'

export const INSPECT_ALLOWANCE_DESCRIPTION =
  'FREE. Deterministically inspect an ERC-20 allowance/revocation request against explicit network/token/spender/value policy. No wallet action, no signing, no chain read unless a separately requested preflight asks for it.'
export const PREFLIGHT_ALLOWANCE_DESCRIPTION =
  'Call BEFORE an agent asks its wallet to approve or revoke a Base USDC ERC-20 allowance. OCD evaluates strict policy and returns a signed portable allowance artifact. ALLOW is policy only, never wallet authority.'
export const OBSERVE_ALLOWANCE_DESCRIPTION =
  'Given a signed OCD allowance preflight artifact and submitted Base transaction hash, independently inspect its canonical-USDC Approval event, Base safe-head finality, and historical allowance state. OCD never executes the transaction.'

export async function inspectAllowance(raw: unknown) {
  const input = parseAllowanceInput(raw)
  const evaluated = evaluateAllowancePolicy(input)
  return { ...evaluated, action: input.action, policy: input.policy, current_allowance: null, signed_artifact: null }
}

export async function preflightAllowance(raw: unknown) {
  const input = parseAllowanceInput(raw)
  const evaluated = evaluateAllowancePolicy(input)
  const current = input.options.observe_current_allowance ? await observeCurrentAllowance(input.action.owner, input.action.spender) : null
  const artifact = await signAllowancePreflight({ ...evaluated, action: input.action, policy: input.policy, pre_action_state: current })
  return { ...evaluated, current_allowance: current, artifact }
}

export async function observeAllowance(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AllowanceInputError('body must be an object')
  const input = raw as Record<string, unknown>
  if (typeof input.transaction_hash !== 'string' || !input.artifact) throw new AllowanceInputError('body must contain artifact and transaction_hash')
  const verification = await verifyAllowanceArtifact(input.artifact)
  if (verification.state !== 'VALID') throw new AllowanceInputError(`preflight artifact is not verifiable: ${verification.code}`)
  const preflight = (input.artifact as { data: AllowancePreflightArtifact }).data
  if (preflight.artifact_type !== 'PREFLIGHT') throw new AllowanceInputError('artifact must be a PREFLIGHT allowance artifact')
  const observation = await observeAllowanceApproval(input.transaction_hash)
  return { artifact: await signAllowanceObservation(preflight, observation) }
}

export function mountAllowanceRoutes(app: Hono): void {
  app.post('/inspect/allowance', async (c) => {
    try { return c.json(await inspectAllowance(await c.req.json()), 200) } catch (err: any) {
      return c.json({ error: err?.message || 'allowance inspection failed' }, err instanceof AllowanceInputError ? 400 : 502)
    }
  })
  app.post('/allowances/observe', async (c) => {
    try { return c.json(await observeAllowance(await c.req.json()), 200) } catch (err: any) {
      return c.json({ error: err?.message || 'allowance observation failed' }, err instanceof AllowanceInputError ? 400 : 502)
    }
  })
  app.post('/verify-allowance-action', async (c) => {
    try { return c.json(await verifyAllowanceArtifact(await c.req.json()), 200) } catch { return c.json({ state: 'INVALID', code: 'body-invalid', message: 'body must be JSON' }, 400) }
  })
}
