#!/usr/bin/env node
/**
 * examples/submit-merchant-evidence.mjs — D2.9A: a tiny, SDK-free example
 * showing how an application that already received a merchant's response
 * can record CALLER_REPORTED evidence with OCD.
 *
 * Deliberately does NOT touch payment execution -- D2.6's SDK/payment code
 * is frozen. This script assumes a payment already happened (you have an
 * operation_id, its recovery_credential, and the merchant's raw response)
 * and only does two things:
 *   1. computes SHA-256 of the raw response body
 *   2. submits the sanitized evidence record to OCD
 *
 * Usage:
 *   OCD_OPERATION_ID=OCD-OP-... \
 *   OCD_RECOVERY_CREDENTIAL=... \
 *   node examples/submit-merchant-evidence.mjs
 *
 * Equivalent curl, once you have the digest:
 *   curl -X POST https://mcp.onchaindiligence.com/operations/$OCD_OPERATION_ID/merchant-evidence \
 *     -H "x-ocd-recovery-credential: $OCD_RECOVERY_CREDENTIAL" \
 *     -H "content-type: application/json" \
 *     -d '{
 *           "resource_url": "https://merchant.example/api/resource",
 *           "http_status": 200,
 *           "content_type": "application/json",
 *           "response_body_digest": "sha256:<64 hex chars>",
 *           "response_bytes": 123
 *         }'
 */
import { createHash } from 'node:crypto'

const MCP_BASE = process.env.OCD_MCP_BASE || 'https://mcp.onchaindiligence.com'
const OPERATION_ID = process.env.OCD_OPERATION_ID
const RECOVERY_CREDENTIAL = process.env.OCD_RECOVERY_CREDENTIAL

if (!OPERATION_ID || !RECOVERY_CREDENTIAL) {
  console.error('Set OCD_OPERATION_ID and OCD_RECOVERY_CREDENTIAL (the SAME ones returned by POST /operations for this payment).')
  process.exit(1)
}

// --- Step 1: this is where YOUR application already has the merchant's ---
// --- real response (from whatever HTTP call it made after payment). We ---
// --- simulate one here so this example is runnable standalone.         ---
const merchantResponse = {
  status: 200,
  contentType: 'application/json',
  resourceUrl: 'https://merchant.example/api/resource',
  rawBody: JSON.stringify({ block_number: 50951350 }), // <-- your real merchant response body goes here
}

function sha256Digest(rawBody) {
  return 'sha256:' + createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

async function main() {
  const digest = sha256Digest(merchantResponse.rawBody)
  const bytes = Buffer.byteLength(merchantResponse.rawBody, 'utf8')

  console.log(`Computed response_body_digest: ${digest} (${bytes} bytes) -- the raw body itself is never sent to OCD.`)

  // --- Step 2: submit the SANITIZED evidence record. Never send the raw
  // body, headers beyond the small allowlist, or anything payment-related.
  const res = await fetch(`${MCP_BASE}/operations/${OPERATION_ID}/merchant-evidence`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ocd-recovery-credential': RECOVERY_CREDENTIAL,
    },
    body: JSON.stringify({
      resource_url: merchantResponse.resourceUrl,
      http_status: merchantResponse.status,
      content_type: merchantResponse.contentType,
      response_body_digest: digest,
      response_bytes: bytes,
      // Optional correlation -- include if your application already has
      // these from the payment execution step. Omitting them is fine; OCD
      // never rejects a submission merely because correlation is unavailable.
      // execution_request_id: '...',
      // provider_reference: '...',
      // transaction_hash: '0x...',
    }),
  })

  const body = await res.json()
  if (!res.ok) {
    console.error(`OCD rejected the evidence submission: HTTP ${res.status}`, body)
    process.exit(1)
  }
  console.log(`Recorded (source: ${body.source}, idempotent_replay: ${body.idempotent_replay}): evidence_id=${body.evidence_id}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
