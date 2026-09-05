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
import { NodeFileRecoveryStore } from '@onchaindiligence/sdk/commerce/node'
import { RecoveryRecordExistsError, RecoveryRecordNotFoundError, VersionConflictError } from '@onchaindiligence/sdk/commerce'

const UPSTREAM = 'https://mcp.onchaindiligence.com'
const ONESOURCE_UPSTREAM = 'https://api.onesource.io'
const PORT = Number(process.env.OPERATOR_PORT || 5757)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])
const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/** Forwards exactly one request to one pinned upstream base+path. Never accepts an arbitrary path from the caller — every call site below hardcodes or validates `upstreamPath` first. */
async function proxyTo(c: any, method: string, upstreamBase: string, upstreamPath: string): Promise<Response> {
  const headers = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer()
  const upstreamRes = await fetch(`${upstreamBase}${upstreamPath}`, { method, headers, body })
  const outHeaders = new Headers()
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value)
  }
  const buf = await upstreamRes.arrayBuffer()
  return new Response(buf, { status: upstreamRes.status, headers: outHeaders })
}

/** Back-compat shorthand for the original five OCD-only proxy routes. */
async function proxy(c: any, method: string, upstreamPath: string): Promise<Response> {
  return proxyTo(c, method, UPSTREAM, upstreamPath)
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

// --- D2.5A: static page for the SDK-driven live reference lifecycle -------
app.get('/d25a', async (c) => {
  const html = await readFile(path.join(__dirname, 'd25a.html'), 'utf8')
  return c.html(html)
})
app.get('/d25a.js', async (c) => {
  const js = await readFile(path.join(__dirname, 'dist', 'd25a.js'), 'utf8')
  return c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})

// --- D2.5A: mirror the D2.4/D2.5 lifecycle surface at the EXACT SAME
// paths the real API uses (no /proxy/ prefix here, unlike the five legacy
// routes above) -- this is what lets the unmodified
// @onchaindiligence/sdk/commerce client point `endpoint: ''` at this local
// server and just work, same-origin, with zero path translation. Still a
// pinned, explicit allowlist -- nothing here forwards an arbitrary path.
app.post('/operations', (c) => proxy(c, 'POST', '/operations'))
app.get('/operations/:id', (c) => proxy(c, 'GET', `/operations/${encodeURIComponent(c.req.param('id') ?? '')}`))
app.post('/x402/lifecycle/preflight-payment', (c) => proxy(c, 'POST', '/x402/lifecycle/preflight-payment'))
app.post('/operations/:id/execution-bindings', (c) =>
  proxy(c, 'POST', `/operations/${encodeURIComponent(c.req.param('id') ?? '')}/execution-bindings`)
)
app.post('/operations/:id/execution-bindings/:execId/state', (c) =>
  proxy(c, 'POST', `/operations/${encodeURIComponent(c.req.param('id') ?? '')}/execution-bindings/${encodeURIComponent(c.req.param('execId') ?? '')}/state`)
)
app.post('/operations/:id/finalize', (c) => proxy(c, 'POST', `/operations/${encodeURIComponent(c.req.param('id') ?? '')}/finalize`))
app.post('/verify-receipt', (c) => proxy(c, 'POST', '/verify-receipt'))
app.get('/receipts/:id', (c) => {
  const id = normalizeReceiptId(c.req.param('id') ?? '')
  if (!id) return c.json({ error: 'not a valid OCD receipt id' }, 400)
  return proxy(c, 'GET', `/receipts/${id}`)
})

// --- D2.5A: proxy the ONE pinned OneSource merchant resource (its own
// origin does not grant this page CORS access -- same-origin proxy avoids
// that, exactly like the OCD proxy routes above). NEVER a general-purpose
// passthrough: only this one exact path is forwarded, to ANY method (GET
// for the free probe, GET again with the x402 payment header attached for
// the paid retry -- x402 "exact" GET resources are paid via the same verb).
const ONESOURCE_RESOURCE_PATH = '/api/chain/block-number'
app.get('/proxy/onesource/block-number', (c) => proxyTo(c, 'GET', ONESOURCE_UPSTREAM, ONESOURCE_RESOURCE_PATH))

// --- D2.5A: recovery-store REST wrapper around the SDK's own
// NodeFileRecoveryStore -- the SDK's commerce client (running IN THE
// BROWSER, since only the browser has the injected wallet) talks to this
// over HTTP exactly like it would to any CommerceRecoveryStore
// implementation; the actual secret-bearing file lives only on this local
// machine's disk, in a directory separate from the legacy /local/session
// file above. See operator/src/httpRecoveryStore.ts for the browser side.
const recoveryStore = new NodeFileRecoveryStore(path.join(__dirname, '.d25a-recovery'))

app.post('/local/recovery', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400)
  }
  try {
    const record = await recoveryStore.create(body)
    return c.json(record, 201)
  } catch (err: any) {
    if (err instanceof RecoveryRecordExistsError) return c.json({ error: err.message }, 409)
    return c.json({ error: err?.message || 'create failed' }, 500)
  }
})

app.get('/local/recovery/:operationId', async (c) => {
  const record = await recoveryStore.load(c.req.param('operationId') ?? '')
  return c.json(record, 200)
})

app.post('/local/recovery/:operationId/update', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400)
  }
  try {
    const record = await recoveryStore.update(c.req.param('operationId') ?? '', body.patch, body.expectedVersion)
    return c.json(record, 200)
  } catch (err: any) {
    if (err instanceof RecoveryRecordNotFoundError) return c.json({ error: err.message }, 404)
    if (err instanceof VersionConflictError) return c.json({ error: err.message }, 409)
    return c.json({ error: err?.message || 'update failed' }, 500)
  }
})

app.get('/local/recovery/by-submission-key/:key', async (c) => {
  const record = await recoveryStore.findByClientSubmissionKey(c.req.param('key') ?? '')
  return c.json(record, 200)
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\nOCD operator commerce UI (LOCAL ONLY): http://localhost:${info.port}/`)
  console.log('This tool is not part of the deployed production app — see operator/README.md.\n')
})
