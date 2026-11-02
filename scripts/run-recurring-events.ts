/**
 * Generate the upcoming occurrences of every recurring event series (M15 #8).
 *
 *   npm run events:recurring
 *
 * The logic lives in lib/events/recurring.ts — the same code the scheduled route
 * app/api/cron/generate-events runs — so the manual and scheduled paths cannot
 * drift. See that file for the lead time, the idempotency guarantee and how a
 * conflicting occurrence is skipped and recorded instead of stalling the series.
 */
import { Client } from 'pg'
import { runRecurringEvents } from '../lib/events/recurring'
import { loadEnv } from './env'

async function main() {
  loadEnv()

  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const client = new Client({ connectionString: url })
  client.on('error', (e) => console.error('connection error:', e.message))
  await client.connect()
  const started = Date.now()

  const r = await runRecurringEvents(client, { log: console.log })

  console.log(
    `✓ ${r.generated} occurrence(s) created, ${r.alreadyExisted} already existed, ` +
      `${r.conflicted} skipped for a resource conflict, ${r.pastSkipped} past period(s) stepped over, ` +
      `${r.advanced} series advanced, ${r.failed} failed (${Date.now() - started}ms)`,
  )

  await client.end()
  if (r.failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
