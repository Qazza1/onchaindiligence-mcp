#!/usr/bin/env node
/**
 * scripts/check-d27-schema.mjs — post-migration verification for D2.7A/B/C.
 *
 * Read-only: queries information_schema/pg_indexes only, changes nothing.
 * Never prints DATABASE_URL or any other secret -- only pass/fail per
 * object, using object names that are already public (this repo's own
 * db/schema.sql).
 *
 * Usage: npm run db:check-d27
 * Requires: DATABASE_URL (same as scripts/migrate.ts).
 */
import { neon } from '@neondatabase/serverless'

const REQUIRED_TABLES = ['accounts', 'webhook_endpoints', 'webhook_events', 'webhook_deliveries']

const REQUIRED_COLUMNS = [
  { table: 'commerce_operations', column: 'owner_id' },
  { table: 'accounts', column: 'account_id' },
  { table: 'accounts', column: 'api_key_hash' },
  { table: 'webhook_endpoints', column: 'signing_secret' },
  { table: 'webhook_endpoints', column: 'status' },
  { table: 'webhook_events', column: 'dedupe_key' },
  { table: 'webhook_deliveries', column: 'next_attempt_at' },
  { table: 'webhook_deliveries', column: 'status' },
]

const REQUIRED_INDEXES = [
  'commerce_operations_owner_idx',
  'finalization_capabilities_preflight_receipt_idx',
  'webhook_endpoints_account_idx',
  'webhook_events_account_idx',
  'webhook_deliveries_webhook_idx',
  'webhook_deliveries_due_idx',
]

const REQUIRED_UNIQUE_CONSTRAINTS = [
  { table: 'webhook_events', columns: ['operation_id', 'type', 'dedupe_key'] },
  { table: 'webhook_deliveries', columns: ['event_id', 'webhook_id'] },
]

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Run `vercel env pull .env.local` or set it in your shell.')
  }
  const sql = neon(databaseUrl)
  const failures = []

  for (const table of REQUIRED_TABLES) {
    const rows = await sql.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table])
    const ok = rows.length > 0
    console.log(`${ok ? 'ok  ' : 'FAIL'} table ${table}`)
    if (!ok) failures.push(`missing table: ${table}`)
  }

  for (const { table, column } of REQUIRED_COLUMNS) {
    const rows = await sql.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])
    const ok = rows.length > 0
    console.log(`${ok ? 'ok  ' : 'FAIL'} column ${table}.${column}`)
    if (!ok) failures.push(`missing column: ${table}.${column}`)
  }

  for (const index of REQUIRED_INDEXES) {
    const rows = await sql.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [index])
    const ok = rows.length > 0
    console.log(`${ok ? 'ok  ' : 'FAIL'} index ${index}`)
    if (!ok) failures.push(`missing index: ${index}`)
  }

  // UNIQUE constraints matter here specifically because they ARE the
  // idempotency mechanism (webhook event/delivery dedupe) -- verify they
  // exist as real constraints, not just "some index happens to cover this".
  for (const { table, columns } of REQUIRED_UNIQUE_CONSTRAINTS) {
    const rows = await sql.query(
      `SELECT tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'UNIQUE'
       GROUP BY tc.constraint_name
       HAVING array_agg(kcu.column_name ORDER BY kcu.ordinal_position) = $2::text[]`,
      [table, columns]
    )
    const ok = rows.length > 0
    console.log(`${ok ? 'ok  ' : 'FAIL'} unique constraint ${table}(${columns.join(', ')})`)
    if (!ok) failures.push(`missing unique constraint: ${table}(${columns.join(', ')})`)
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`NOT READY -- ${failures.length} D2.7 schema object(s) missing:`)
    for (const f of failures) console.log(`  - ${f}`)
    console.log('\nRun `npm run db:migrate` against this DATABASE_URL, then re-run this check.')
    process.exitCode = 1
  } else {
    console.log('D2.7 SCHEMA: READY (all required tables/columns/indexes/constraints present)')
  }
}

main().catch((err) => {
  console.error('D2.7 schema check failed:', err.message)
  process.exitCode = 1
})
