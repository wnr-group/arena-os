/**
 * Rebuilds the reporting aggregates (AROS-64).
 *
 *   npx tsx scripts/refresh-reports.ts
 *
 * WHY THIS IS A SCRIPT AND NOT A JOB. mv_daily_revenue is a snapshot: it does
 * not update when an invoice is raised, so a report is only as fresh as the
 * last refresh. This project has no scheduler — no cron, no queue, no job
 * table (the `notifications` outbox in the roadmap is not one) — and AROS-64 is
 * not the ticket that invents one. So the refresh is an explicit operation:
 * run it from a host scheduler (cron/systemd timer/Task Scheduler/a platform
 * cron job) as often as the reports need to be current, e.g. hourly:
 *
 *   0 * * * * cd /srv/arena-os && npx tsx scripts/refresh-reports.ts
 *
 * Runs as the OWNER role, like migrations: refreshing is an owner-level
 * operation over every tenant's data at once, and public.refresh_daily_revenue()
 * is deliberately granted to nobody else.
 *
 * REFRESH … CONCURRENTLY holds no exclusive lock, so reports keep serving the
 * previous snapshot while this runs; it requires the unique index
 * mv_daily_revenue_key, and it cannot run inside a transaction block — which is
 * why this uses a plain client and not the migration runner.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

async function main() {
  loadEnv()

  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const client = new Client({ connectionString: url })
  await client.connect()

  const started = Date.now()
  process.stdout.write('→ refreshing mv_daily_revenue … ')
  // No BEGIN anywhere: node-postgres is autocommit by default, and
  // CONCURRENTLY is rejected inside a transaction block.
  await client.query('select public.refresh_daily_revenue()')
  const { rows } = await client.query<{ n: string }>('select count(*)::text n from public.mv_daily_revenue')
  console.log(`ok (${rows[0].n} rows, ${Date.now() - started}ms)`)

  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
