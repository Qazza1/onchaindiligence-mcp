/**
 * scripts/migrate.ts — applies db/schema.sql to DATABASE_URL.
 *
 * Idempotent: schema.sql is entirely CREATE ... IF NOT EXISTS, so running
 * this twice against the same database is a safe no-op the second time.
 * Never mutates existing columns/rows.
 *
 * Usage: npm run db:migrate
 * Requires: DATABASE_URL (set by the Vercel Postgres/Neon integration; also
 * present in .env.local for local runs via `vercel env pull`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { neon } from '@neondatabase/serverless'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Run `vercel env pull .env.local` or set it in your shell.')
  }
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
  const sql = neon(databaseUrl)
  // The HTTP driver's prepared-statement protocol rejects multiple commands
  // in one call ("cannot insert multiple commands into a prepared
  // statement"), so split on statement boundaries and run each separately.
  // Strip full-line AND trailing `--` comments first — schema.sql's prose
  // comments contain plain-English semicolons ("...mutation; it never..."),
  // which would otherwise be mistaken for statement boundaries. None of this
  // file's comments or string literals contain a literal `--`, so a simple
  // strip is safe here.
  const withoutComments = schema
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const statement of statements) {
    await sql.query(statement)
    console.log(`ok  ${statement.split('\n')[0]}…`)
  }
  console.log(`Schema applied: ${statements.length} statements (idempotent — safe to re-run).`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
