/**
 * server.ts — D2.2B local operator server.
 *
 * Serves the operator commerce UI (index.html + the esbuild-bundled browser
 * app.js) and reverse-proxies a fixed allowlist of exactly five upstream
 * paths to the live mcp.onchaindiligence.com API. The browser therefore only
 * ever talks to http://localhost — same-origin — so no CORS change was
 * needed anywhere in the production API to build this tool.
 *
 * This file is never imported by index.ts (the production Vercel entrypoint)
 * and is started only via `npm run operator:commerce`. It is not part of any
 * deployment.
 *
 * Also hosts POST /local/verify-receipt, a thin wrapper around
 * src/receipts.ts's verifyReceiptEnvelope()/fetchAttestationKeyRegistry().
 * That module uses node:crypto (createPublicKey/verify), which cannot be
 * bundled into a browser page — so receipt-proof verification runs here,
 * server-side, and the browser only displays the VALID/INVALID/UNVERIFIABLE
 * verdict this endpoint returns.
 */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { fetchAttestationKeyRegistry, verifyReceiptEnvelope, normalizeReceiptId } from '../src/receipts.js'
import { RECIPIENT } from '../src/lifecycleCore.js'

const UPSTREAM = 'https://mcp.onchaindiligence.com'
const PORT = Number(process.env.OPERATOR_PORT || 5757)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])
const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/** Forwards exactly one request to one pinned upstream path. Never accepts an arbitrary path from the caller — every call site below hardcodes or validates `upstreamPath` first. */
async function proxy(c: any, method: string, upstreamPath: string): Promise<Response> {
  const headers = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer()
  const upstreamRes = await fetch(`${UPSTREAM}${upstreamPath}`, { method, headers, body })
  const outHeaders = new Headers()
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value)
  }
  const buf = await upstreamRes.arrayBuffer()
  return new Response(buf, { status: upstreamRes.status, headers: outHeaders })
}

const app = new Hono()

// --- static ---------------------------------------------------------------
app.get('/', async (c) => {
  const html = await readFile(path.join(__dirname, 'index.html'), 'utf8')
  return c.html(html)
})
app.get('/app.js', async (c) => {
  const js = await readFile(path.join(__dirname, 'dist', 'app.js'), 'utf8')
  return c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})

// --- proxy allowlist: exactly the five pinned lifecycle endpoints ----------
app.post('/proxy/inspect/payment', (c) => proxy(c, 'POST', '/inspect/payment'))
app.post('/proxy/x402/preflight-payment', (c) => proxy(c, 'POST', '/x402/preflight-payment'))
app.get('/proxy/x402/screen/:address', (c) => {
  const address = c.req.param('address') ?? ''
  if (address.toLowerCase() !== RECIPIENT.toLowerCase()) {
    return c.json({ error: 'operator proxy only permits screening the pinned OCD recipient address' }, 400)
  }
  return proxy(c, 'GET', `/x402/screen/${RECIPIENT}`)
})
app.post('/proxy/receipts/finalize', (c) => proxy(c, 'POST', '/receipts/finalize'))
app.get('/proxy/receipts/:id', (c) => {
  const id = normalizeReceiptId(c.req.param('id') ?? '')
  if (!id) return c.json({ error: 'not a valid OCD receipt id' }, 400)
  return proxy(c, 'GET', `/receipts/${id}`)
})

// --- local-only receipt verification ---------------------------------------
app.post('/local/verify-receipt', async (c) => {
  let envelope: unknown
  try {
    envelope = await c.req.json()
  } catch {
    return c.json({ state: 'INVALID', code: 'bad-json', message: 'body was not valid JSON' }, 400)
  }
  try {
    const registry = await fetchAttestationKeyRegistry()
    const result = verifyReceiptEnvelope(envelope as Parameters<typeof verifyReceiptEnvelope>[0], registry)
    return c.json(result, 200)
  } catch (err: any) {
    return c.json({ state: 'UNVERIFIABLE', code: 'verification-error', message: err?.message || 'verification failed' }, 200)
  }
})

// --- D2.5 (Section 12): local-only session persistence ---------------------
//
// Fixes "refresh -> capability disappears -> user wonders whether to pay
// again" WITHOUT moving custody into OCD and WITHOUT putting the
// finalization capability or any recovery credential into the BROWSER's
// storage (localStorage/sessionStorage/IndexedDB) -- D2.5's explicit
// instruction. Instead, the capability is persisted to a single local JSON
// file on THIS machine, written only by this local Node server (never by
// the browser directly), and read back only by this same server on request.
// It is exactly as trustworthy as this machine's own file permissions --
// the same trust boundary the operator already assumes for
// BUYER_PRIVATE_KEY-adjacent local tooling. Gitignored; never logged.
const SESSION_FILE = path.join(__dirname, '.local-session.json')

interface LocalSession {
  preflightReceiptId: string | null
  capability: string | null
  capabilityExpiresAt: string | null
  transactionHash: string | null
  savedAt: string
}

app.post('/local/session', async (c) => {
  let body: Partial<LocalSession>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400)
  }
  const session: LocalSession = {
    preflightReceiptId: body.preflightReceiptId ?? null,
    capability: body.capability ?? null,
    capabilityExpiresAt: body.capabilityExpiresAt ?? null,
    transactionHash: body.transactionHash ?? null,
    savedAt: new Date().toISOString(),
  }
  // Write-then-rename: a crash mid-write can never leave a half-written,
  // corrupt session file behind.
  const tempPath = `${SESSION_FILE}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tempPath, JSON.stringify(session, null, 2), 'utf8')
  await rename(tempPath, SESSION_FILE)
  return c.json({ ok: true })
})

app.get('/local/session', async (c) => {
  try {
    const text = await readFile(SESSION_FILE, 'utf8')
    return c.json(JSON.parse(text) as LocalSession, 200)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return c.json(null, 200)
    return c.json({ error: 'could not read local session file' }, 500)
  }
})

app.delete('/local/session', async (c) => {
  await unlink(SESSION_FILE).catch(() => {})
  return c.json({ ok: true })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\nOCD operator commerce UI (LOCAL ONLY): http://localhost:${info.port}/`)
  console.log('This tool is not part of the deployed production app — see operator/README.md.\n')
})
