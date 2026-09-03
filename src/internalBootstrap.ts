/**
 * internalBootstrap.ts — TEMPORARY, ONE-SHOT route used only to mint the
 * first real D2.0A reference receipt. Gated by RECEIPT_BOOTSTRAP_TOKEN (a
 * one-off secret distinct from ATTESTATION_SERVICE_TOKEN, minted solely for
 * this bootstrap and never reused). Delete this file, its mount point in
 * index.ts, and the Vercel environment variable after the signed envelope is
 * baked into src/receipts/referenceReceipts.ts. Do not leave this route live.
 *
 * Exists because the real signing key is only reachable through the one
 * process holding ATTESTATION_PRIVATE_KEY (the HTTP API), whose shared
 * ATTESTATION_SERVICE_TOKEN this deployment already holds at runtime but
 * which cannot be read back out of Vercel (it is marked Sensitive). Running
 * the signing call from inside this deployment — where that token is
 * already correctly available — avoids ever needing to know or handle it.
 */
import type { Hono } from 'hono'
import { attest } from './attest.js'
import { timingSafeEqual } from 'node:crypto'
import { fetchAttestationKeyRegistry, verifyReceiptEnvelope, PUBLIC_ACTION_RECEIPT_SCHEMA, PUBLIC_ACTION_RECEIPT_PURPOSE, type PublicActionReceiptEnvelope } from './receipts.js'
import { REFERENCE_RECEIPT, REFERENCE_RECEIPT_DIGEST, REFERENCE_RECEIPT_ID } from './receipts/referenceReceiptData.js'

let signingResult: Promise<{ envelope: PublicActionReceiptEnvelope; verification: ReturnType<typeof verifyReceiptEnvelope> }> | null = null

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function mountInternalBootstrap(app: Hono): void {
  app.post('/internal/bootstrap-reference-receipt', async (c) => {
    const token = process.env.RECEIPT_BOOTSTRAP_TOKEN
    if (!token) {
      return c.json({ error: 'bootstrap is not configured' }, 503)
    }
    const auth = c.req.header('authorization')
    if (!tokenMatches(auth?.replace(/^Bearer /, ''), token)) {
      c.header('WWW-Authenticate', 'Bearer realm="internal-bootstrap"')
      return c.json({ error: 'unauthorized' }, 401)
    }

    try {
      if (!signingResult) {
        signingResult = (async () => {
          if (REFERENCE_RECEIPT.receipt_id !== REFERENCE_RECEIPT_ID || REFERENCE_RECEIPT.receipt_digest !== REFERENCE_RECEIPT_DIGEST) {
            throw new Error('fixed bootstrap receipt id or digest mismatch')
          }
          const signed = await attest(REFERENCE_RECEIPT, { purpose: PUBLIC_ACTION_RECEIPT_PURPOSE })
          const envelope: PublicActionReceiptEnvelope = {
            schema: PUBLIC_ACTION_RECEIPT_SCHEMA,
            receipt: REFERENCE_RECEIPT,
            proof: signed.attestation as PublicActionReceiptEnvelope['proof'],
          }
          const registry = await fetchAttestationKeyRegistry()
          const verification = verifyReceiptEnvelope(envelope, registry)
          if (verification.state !== 'VALID') throw new Error(`bootstrap verification failed: ${verification.code}`)
          return { envelope, verification }
        })()
      }
      return c.json(await signingResult, 200)
    } catch (err: any) {
      return c.json({ error: err?.message || 'bootstrap failed' }, 500)
    }
  })
}
