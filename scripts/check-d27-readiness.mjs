#!/usr/bin/env node
/**
 * scripts/check-d27-readiness.mjs — D2.7 deployment readiness gate.
 *
 * Deliberately NOT a full environment auditor: it checks exactly the
 * things D2.7 (accounts/history/webhooks/investigation) needs before a
 * deploy, nothing more. Anything that genuinely cannot be checked from a
 * local run (Vercel project env vars, the live cron invocation itself) is
 * printed as an explicit MANUAL DEPLOY CHECK, never silently assumed.
 *
 * Read-only where it touches a database. Never prints DATABASE_URL,
 * WEBHOOK_WORKER_SECRET, or any other secret value -- only whether each is
 * set.
 *
 * Usage: npm run check:d27-readiness
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { neon } from '@neondatabase/serverless'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const blockers = []
const manualChecks = []

function section(title) {
  console.log(`\n=== ${title} ===`)
}

// --- 1. database connectivity + D2.7 schema --------------------------------

section('1. Database')
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.log('DATABASE_URL:        not set in this shell')
  manualChecks.push('Confirm DATABASE_URL is configured for the target deploy (Vercel Postgres/Neon integration) and run `npm run db:migrate` + `npm run db:check-d27` against it.')
} else {
  try {
    const sql = neon(databaseUrl)
    await sql.query('SELECT 1')
    console.log('connectivity:        ok')

    const requiredTables = ['accounts', 'webhook_endpoints', 'webhook_events', 'webhook_deliveries']
    let allTablesPresent = true
    for (const table of requiredTables) {
      const rows = await sql.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table])
      if (rows.length === 0) allTablesPresent = false
    }
    const ownerIdRows = await sql.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commerce_operations' AND column_name = 'owner_id'`)
    const schemaReady = allTablesPresent && ownerIdRows.length > 0
    console.log(`D2.7 schema present: ${schemaReady ? 'yes' : 'NO'}`)
    if (!schemaReady) blockers.push('D2.7 schema is not fully applied to this database -- run `npm run db:migrate`, then `npm run db:check-d27` for the full breakdown.')
  } catch (err) {
    blockers.push(`could not connect to DATABASE_URL: ${err.message}`)
    console.log(`connectivity:        FAILED -- ${err.message}`)
  }
}

// --- 2. routes mounted (static source check -- see this file's header for why) ---

section('2. Routes (static source check)')
const indexTs = readFileSync(join(repoRoot, 'index.ts'), 'utf8')
const routeChecks = [
  { label: 'account routes (POST /accounts, GET /me/operations)', pattern: /mountAccountHistory\(app\)/ },
  { label: 'webhook routes (POST/GET /me/webhooks, DELETE, deliveries)', pattern: /mountWebhooks\(app\)/ },
]
for (const { label, pattern } of routeChecks) {
  const ok = pattern.test(indexTs)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) blockers.push(`index.ts does not mount: ${label}`)
}
// Investigation routes are mounted by mountAccountHistory() itself (see
// src/accountHistoryRoute.ts) -- verify directly in that file rather than
// re-deriving it from index.ts.
const accountHistoryRouteTs = readFileSync(join(repoRoot, 'src', 'accountHistoryRoute.ts'), 'utf8')
const investigationRoutesOk = /\/me\/operations\/:operationId\/investigation/.test(accountHistoryRouteTs) && /\/me\/operations\/:operationId\/investigation\/export/.test(accountHistoryRouteTs)
console.log(`${investigationRoutesOk ? 'ok  ' : 'FAIL'} investigation routes (GET .../investigation, .../investigation/export)`)
if (!investigationRoutesOk) blockers.push('src/accountHistoryRoute.ts does not define the investigation/export routes')
manualChecks.push('After deploy, confirm live: `curl -i https://<mcp-host>/me/operations` returns 401 (not 404) to prove the route is actually reachable in production, not just present in source.')

// --- 3. webhook worker secret + cron -----------------------------------------

section('3. Webhook worker secret + cron')
// Vercel Cron only auto-sends `Authorization: Bearer <value>` when the
// project has a `CRON_SECRET` env var -- a differently-named var is never
// populated into that header automatically. WEBHOOK_WORKER_SECRET is kept
// as a secondary, manually-invoked path (see src/webhookRoute.ts).
const cronSecretSet = typeof process.env.CRON_SECRET === 'string' && process.env.CRON_SECRET.length > 0
const workerSecretSet = typeof process.env.WEBHOOK_WORKER_SECRET === 'string' && process.env.WEBHOOK_WORKER_SECRET.length > 0
console.log(`CRON_SECRET set locally:           ${cronSecretSet}  (this is what Vercel's OWN cron auth mechanism uses)`)
console.log(`WEBHOOK_WORKER_SECRET set locally: ${workerSecretSet}  (secondary, for manual/non-Vercel invocation)`)
if (!cronSecretSet && !workerSecretSet) {
  manualChecks.push('Set CRON_SECRET in the Vercel project\'s production environment variables before deploying -- Vercel automatically sends it as the Authorization header on every cron invocation of /internal/webhooks/deliver (see src/webhookRoute.ts). WEBHOOK_WORKER_SECRET is an acceptable alternative only for manual/non-Vercel invocation.')
}
manualChecks.push('Confirm the Vercel project tier supports the configured cron frequency -- Hobby plans historically limit cron jobs to once/day; vercel.json currently requests every minute, which needs a Pro (or higher) plan.')

let vercelJson
try {
  vercelJson = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'))
} catch (err) {
  blockers.push(`could not read/parse vercel.json: ${err.message}`)
}
if (vercelJson) {
  const cron = (vercelJson.crons || []).find((c) => c.path === '/internal/webhooks/deliver')
  console.log(`vercel.json cron entry for /internal/webhooks/deliver: ${cron ? `yes (schedule: ${cron.schedule})` : 'NO'}`)
  if (!cron) blockers.push('vercel.json has no cron entry for /internal/webhooks/deliver')
}
manualChecks.push('After deploy, confirm in the Vercel dashboard (Project -> Cron Jobs) that the /internal/webhooks/deliver cron is registered and its recent invocations return 200, not 401/500 -- this is the live proof that CRON_SECRET actually reached the route.')

// --- result -----------------------------------------------------------------

section('RESULT')
if (manualChecks.length > 0) {
  console.log('Manual deploy checks (cannot be verified from this local run):')
  for (const m of manualChecks) console.log(`  - ${m}`)
}
if (blockers.length > 0) {
  console.log('\nNOT READY. Blocking issues:')
  for (const b of blockers) console.log(`  - ${b}`)
  process.exitCode = 1
} else {
  console.log('\nREADY FOR D2.7 DEPLOY (locally verifiable checks passed -- see manual deploy checks above before actually deploying)')
}
