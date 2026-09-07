#!/usr/bin/env node
/**
 * examples/webhook-receiver.mjs — a tiny, real HTTP server demonstrating
 * how to receive and verify an OnChainDiligence D2.7B webhook delivery.
 *
 * This is NOT a service this product runs -- it's a runnable example for
 * developers integrating webhooks, mirroring exactly what
 * src/webhookDelivery.ts sends and src/webhookSigning.ts signs with.
 *
 * Usage:
 *   OCD_WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.mjs
 *   (then register this URL, e.g. via ngrok, with POST /me/webhooks)
 *
 * What it does:
 *   1. Reads the raw request body (unparsed -- signature verification MUST
 *      happen over the exact bytes sent, before any JSON.parse).
 *   2. Recomputes HMAC-SHA256("<timestamp>.<raw body>", secret) and compares
 *      it (constant-time) against the x-ocd-webhook-signature header.
 *   3. Only after verification succeeds, parses the body and prints the
 *      event type + operation id.
 *   4. Returns 200 so this delivery is marked `delivered` -- any non-2xx
 *      (or no response within the timeout) causes OCD to retry with the
 *      SAME event id (see webhookDelivery.ts's retry schedule).
 */
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.OCD_WEBHOOK_SECRET
const PORT = Number(process.env.PORT || 8787)

if (!SECRET) {
  console.error('Set OCD_WEBHOOK_SECRET to the signing_secret shown once when you created the webhook (POST /me/webhooks).')
  process.exit(1)
}

/** The exact verification a receiver should implement -- mirrors src/webhookSigning.ts's verifyWebhookSignature(). */
function verify(secret, timestamp, rawBody, signatureHeader) {
  const expected = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader || '', 'utf8')
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const timestamp = req.headers['x-ocd-webhook-timestamp']
    const signature = req.headers['x-ocd-webhook-signature']
    const eventId = req.headers['x-ocd-webhook-id']

    if (!timestamp || !signature || !verify(SECRET, timestamp, rawBody, signature)) {
      console.error(`REJECTED (bad signature) event_id=${eventId || 'unknown'}`)
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid signature' }))
      return
    }

    // Optional but recommended: reject a timestamp far in the past/future
    // to bound replay of a captured-but-still-validly-signed request.
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (ageSeconds > 300) {
      console.error(`REJECTED (stale timestamp, ${Math.round(ageSeconds)}s old) event_id=${eventId}`)
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'timestamp too old' }))
      return
    }

    let envelope
    try {
      envelope = JSON.parse(rawBody)
    } catch {
      res.writeHead(400).end()
      return
    }

    // Deduplicate using envelope.id -- a retried delivery reuses the SAME
    // event id (see webhookDelivery.ts's header). A real integration would
    // check this against its own already-processed-event store.
    console.log(`OK  type=${envelope.type}  event_id=${envelope.id}  operation_id=${envelope.operation_id}`)
    console.log('    data:', JSON.stringify(envelope.data))

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ received: true }))
  })
})

server.listen(PORT, () => console.log(`webhook-receiver example listening on http://localhost:${PORT}`))
