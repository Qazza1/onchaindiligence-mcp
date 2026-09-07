#!/usr/bin/env node
/**
 * scripts/smoke-d27.mjs — post-deploy smoke test for D2.7A/B/C.
 *
 * Makes ZERO payments and ZERO PayBox/merchant/finalization calls -- every
 * request here is either free (POST /accounts, POST /operations) or reads
 * already-created state. Never touches D2.6's reviewed executor/harness.
 *
 * Flow:
 *   1. create a temporary pilot account (account A)
 *   2. create a SECOND temporary account (account B), used only to prove
 *      cross-account isolation
 *   3. confirm GET /me/operations works for account A (starts empty)
 *   4. create an owned, empty operation via POST /operations with account
 *      A's Authorization header (no preflight, no payment)
 *   5. confirm it appears in account A's history, and NOT in account B's
 *   6. confirm GET /me/operations/:id (detail) for account A
 *   7. confirm GET /me/operations/:id/investigation
 *   8. confirm GET /me/operations/:id/investigation/export
 *   9. register a webhook endpoint for account A (registration only -- no
 *      real receiver needed, no delivery is triggered by this script),
 *      confirm it lists without its signing_secret, then delete it
 *
 * What this script deliberately does NOT do (would need a real DB/PayBox/
 * finalization credential this script has no business touching):
 *   - paid preflight
 *   - PayBox execution
 *   - merchant payment
 *   - finalization against a real or fake transaction
 *   - deleting the temporary accounts/operations it created (D2.7A has no
 *     delete-account or delete-operation route by design -- operations are
 *     durable records; this is disclosed at the end, not a cleanup bug)
 *
 * Usage:
 *   MCP_BASE_URL=https://mcp.onchaindiligence.com node scripts/smoke-d27.mjs
 *   (defaults to https://mcp.onchaindiligence.com if unset)
 */
const BASE = process.env.MCP_BASE_URL || 'https://mcp.onchaindiligence.com'

let passed = 0
let failed = 0
const failures = []

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`ok    ${label}`)
    passed++
  } else {
    console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
    failed++
    failures.push(label)
  }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON response -- body stays null, caller checks res.status */
  }
  return { status: res.status, body }
}

function authHeader(apiKey) {
  return { Authorization: `Bearer ${apiKey}` }
}

async function main() {
  console.log(`D2.7 SMOKE TEST against ${BASE}`)
  console.log('No payment. No PayBox call. No finalization.\n')

  // --- 1/2: two temporary accounts ------------------------------------
  const createA = await req('/accounts', { method: 'POST' })
  ok('create temporary account A', createA.status === 201 && createA.body?.account_id && createA.body?.api_key, `status ${createA.status}`)
  const createB = await req('/accounts', { method: 'POST' })
  ok('create temporary account B (isolation control)', createB.status === 201 && createB.body?.account_id && createB.body?.api_key, `status ${createB.status}`)
  if (!createA.body?.api_key || !createB.body?.api_key) {
    console.log('\nCannot continue without both accounts -- stopping.')
    process.exitCode = 1
    return
  }
  const apiKeyA = createA.body.api_key
  const apiKeyB = createB.body.api_key

  // --- 3: empty history works ------------------------------------------
  const emptyHistory = await req('/me/operations', { headers: authHeader(apiKeyA) })
  ok('GET /me/operations works for a fresh account', emptyHistory.status === 200 && Array.isArray(emptyHistory.body?.operations), `status ${emptyHistory.status}`)

  // --- 4: create an owned, empty operation (free -- no preflight, no payment) ---
  const createOp = await req('/operations', { method: 'POST', headers: authHeader(apiKeyA) })
  ok('create an owned operation via POST /operations with account A auth', createOp.status === 201 && typeof createOp.body?.operation_id === 'string', `status ${createOp.status}`)
  const operationId = createOp.body?.operation_id
  const recoveryCredential = createOp.body?.recovery_credential
  if (!operationId) {
    console.log('\nCannot continue without a created operation -- stopping.')
    process.exitCode = 1
    return
  }

  // --- 5: appears only for the owning account --------------------------
  const historyA = await req('/me/operations', { headers: authHeader(apiKeyA) })
  ok('the new operation appears in account A\'s history', historyA.body?.operations?.some((o) => o.operation_id === operationId) === true)
  const historyB = await req('/me/operations', { headers: authHeader(apiKeyB) })
  ok('the new operation does NOT appear in account B\'s history', historyB.body?.operations?.some((o) => o.operation_id === operationId) !== true)
  const detailAsB = await req(`/me/operations/${operationId}`, { headers: authHeader(apiKeyB) })
  ok('account B gets 404 reading account A\'s operation detail directly', detailAsB.status === 404, `status ${detailAsB.status}`)

  // --- 6: operation detail ----------------------------------------------
  const detailAsA = await req(`/me/operations/${operationId}`, { headers: authHeader(apiKeyA) })
  ok('GET /me/operations/:id (detail) works for the owning account', detailAsA.status === 200 && detailAsA.body?.operation_id === operationId, `status ${detailAsA.status}`)

  // --- 7: investigation ---------------------------------------------------
  const investigation = await req(`/me/operations/${operationId}/investigation`, { headers: authHeader(apiKeyA) })
  ok(
    'GET /me/operations/:id/investigation returns the assembled object',
    investigation.status === 200 && investigation.body?.operation?.operation_id === operationId && investigation.body?.preflight && investigation.body?.execution && investigation.body?.settlement && investigation.body?.evidence && investigation.body?.receipts && investigation.body?.recovery,
    `status ${investigation.status}`
  )
  // D2.8A: findings is always an array (deriveFindings() is unconditional --
  // src/investigation.ts), even for a bare, incomplete operation like this
  // smoke fixture (which never pays/finalizes) -- confirms the findings
  // engine is wired into production, not just present in the type.
  ok('GET /me/operations/:id/investigation includes a findings array (D2.8A)', Array.isArray(investigation.body?.findings), `findings: ${JSON.stringify(investigation.body?.findings)}`)

  // --- 8: investigation export ---------------------------------------------
  const exported = await req(`/me/operations/${operationId}/investigation/export`, { headers: authHeader(apiKeyA) })
  ok('GET /me/operations/:id/investigation/export returns the manifest-wrapped package', exported.status === 200 && exported.body?.schema === 'onchaindiligence.investigation.v1' && typeof exported.body?.digest === 'string', `status ${exported.status}`)

  // --- 8b: D2.9A merchant evidence (recovery-credential-gated, not account-gated) ---
  // A synthetic digest standing in for "the caller already hashed the raw
  // response body locally" -- this script never sends and the route never
  // accepts a raw body field, so there is nothing for the server to store
  // even if it wanted to. response_headers deliberately includes both an
  // allowlisted header (etag) and a disallowed one (x-smoke-test-secret)
  // to prove sanitization actually happens against a live server, not just
  // in the unit tests.
  const submitEvidence = await req(`/operations/${operationId}/merchant-evidence`, {
    method: 'POST',
    headers: { 'x-ocd-recovery-credential': recoveryCredential, 'content-type': 'application/json' },
    body: JSON.stringify({
      resource_url: 'https://example.com/ocd-smoke-test-resource',
      http_status: 200,
      content_type: 'application/json',
      response_body_digest: 'sha256:' + '11'.repeat(32),
      response_bytes: 42,
      response_headers: { etag: 'W/"smoke-test-etag"', 'x-smoke-test-secret': 'must-never-be-stored' },
    }),
  })
  ok(
    'POST /operations/:id/merchant-evidence attaches evidence (recovery-credential-gated)',
    submitEvidence.status === 201 && submitEvidence.body?.source === 'CALLER_REPORTED' && typeof submitEvidence.body?.evidence_id === 'string',
    `status ${submitEvidence.status} body ${JSON.stringify(submitEvidence.body)}`
  )
  ok('merchant evidence response reports the digest/byte-count as submitted, never a raw body field', submitEvidence.body?.response_body_digest === 'sha256:' + '11'.repeat(32) && submitEvidence.body?.response_bytes === 42 && submitEvidence.body?.response_body === undefined && submitEvidence.body?.body === undefined)

  const investigationAfterEvidence = await req(`/me/operations/${operationId}/investigation`, { headers: authHeader(apiKeyA) })
  const latestEvidence = investigationAfterEvidence.body?.merchant_response?.evidence?.at(-1)
  ok('investigation.merchant_response.evidence[] contains the newly attached record', Boolean(latestEvidence) && latestEvidence.evidence_id === submitEvidence.body?.evidence_id, `merchant_response: ${JSON.stringify(investigationAfterEvidence.body?.merchant_response)}`)
  ok('investigation surfaces source: CALLER_REPORTED (never upgraded)', latestEvidence?.source === 'CALLER_REPORTED')
  // Neither the submit response nor the investigation view echoes headers
  // back at all (by design -- see Investigation.merchant_response.evidence's
  // own field list, which has no headers field) -- confirm the disallowed
  // header genuinely never appears in ANY HTTP response this script saw.
  // Allowlist-preservation on the actual persisted row is a separate,
  // read-only production DB check (see deliverable) since there is no HTTP
  // surface that echoes sanitized headers back to verify it against.
  const allResponsesBlob = JSON.stringify({ submitEvidence: submitEvidence.body, investigation: investigationAfterEvidence.body })
  ok('the disallowed header never appears in any HTTP response', !allResponsesBlob.includes('smoke-test-secret') && !allResponsesBlob.includes('must-never-be-stored'))

  const exportedAfterEvidence = await req(`/me/operations/${operationId}/investigation/export`, { headers: authHeader(apiKeyA) })
  ok('investigation export also contains the merchant evidence record', JSON.stringify(exportedAfterEvidence.body).includes(submitEvidence.body?.evidence_id ?? '\0'))

  // --- 8c: idempotent replay -- identical evidence must not duplicate ------
  const submitEvidenceAgain = await req(`/operations/${operationId}/merchant-evidence`, {
    method: 'POST',
    headers: { 'x-ocd-recovery-credential': recoveryCredential, 'content-type': 'application/json' },
    body: JSON.stringify({
      resource_url: 'https://example.com/ocd-smoke-test-resource',
      http_status: 200,
      content_type: 'application/json',
      response_body_digest: 'sha256:' + '11'.repeat(32),
      response_bytes: 42,
      response_headers: { etag: 'W/"smoke-test-etag"', 'x-smoke-test-secret': 'must-never-be-stored' },
    }),
  })
  ok(
    'an identical resubmission is idempotent -- same evidence_id, no duplicate row',
    submitEvidenceAgain.status === 200 && submitEvidenceAgain.body?.idempotent_replay === true && submitEvidenceAgain.body?.evidence_id === submitEvidence.body?.evidence_id,
    `status ${submitEvidenceAgain.status} body ${JSON.stringify(submitEvidenceAgain.body)}`
  )

  // --- 9: webhook registration/list/delete (no real receiver, no delivery triggered by this script) ---
  const createWebhook = await req('/me/webhooks', { method: 'POST', headers: { ...authHeader(apiKeyA), 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/ocd-smoke-test-placeholder' }) })
  ok('register a webhook endpoint for account A', createWebhook.status === 201 && typeof createWebhook.body?.signing_secret === 'string', `status ${createWebhook.status}`)
  const webhookId = createWebhook.body?.webhook_id
  if (webhookId) {
    const listWebhooks = await req('/me/webhooks', { headers: authHeader(apiKeyA) })
    const listed = listWebhooks.body?.webhooks?.find((w) => w.webhook_id === webhookId)
    ok('the registered webhook is listed WITHOUT its signing_secret', Boolean(listed) && listed.signing_secret === undefined)
    const deleteWebhook = await req(`/me/webhooks/${webhookId}`, { method: 'DELETE', headers: authHeader(apiKeyA) })
    ok('delete the webhook endpoint (cleanup)', deleteWebhook.status === 200, `status ${deleteWebhook.status}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  console.log('\nNOT cleaned up (no delete route exists for these by design -- durable records, not test fixtures):')
  console.log(`  - account A: ${createA.body.account_id}`)
  console.log(`  - account B: ${createB.body.account_id}`)
  console.log(`  - operation: ${operationId}`)
  console.log('\nNo payment, PayBox call, or finalization was performed by this script.')

  if (failed > 0) {
    console.log(`\nFAILED checks: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err)
  process.exitCode = 1
})
