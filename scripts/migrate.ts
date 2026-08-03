/**
 * Applies pending SQL migrations from db/migrations in filename order, as the
 * OWNER role. Each file runs once, inside a transaction, tracked in _migrations.
 *
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { loadEnv } from './env'

async function main() {
  loadEnv()

  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const client = new Client({ connectionString: url })
  await client.connect()

  await client.query(`
    create table if not exists public._migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const dir = resolve(process.cwd(), 'db/migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const { rows } = await client.query<{ name: string }>('select name from public._migrations')
  const applied = new Set(rows.map((r) => r.name))

  let ran = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(resolve(dir, file), 'utf8')
    process.stdout.write(`→ applying ${file} … `)
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into public._migrations(name) values ($1)', [file])
      await client.query('commit')
      console.log('ok')
      ran++
    } catch (e) {
      await client.query('rollback')
      console.log('FAILED')
      throw e
    }
  }

  console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`)
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
