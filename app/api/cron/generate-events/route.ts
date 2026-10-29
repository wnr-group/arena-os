import { NextResponse, type NextRequest } from 'next/server'
import { Client } from 'pg'
import { cronAuthFailure } from '@/lib/cron/auth'
import { runRecurringEvents } from '@/lib/events/recurring'
import { pruneOldPrintJobs } from '@/lib/printing/retention'

/**
 * Scheduler hook for generating recurring event occurrences (M15 #8) — the
 * Vercel option next to `npm run events:recurring`, running the very same
 * lib/events/recurring.ts.
 *
 * Machine-to-machine: no session, no tenant. Authentication is the shared
 * CRON_SECRET bearer check in lib/cron/auth.ts. It writes across tenants, so it
 * connects as the owner role like the CLI job; the response is only counts —
 * never an event, tenant or secret.
 *
 * Safe to call repeatedly or concurrently: occurrences are unique per
 * (series, period) and each series is processed under its own row lock.
 *
 * This is the project's one daily job, so it also carries the housekeeping that
 * needs no schedule of its own: pruning finished print jobs (lib/printing/
 * retention.ts). That runs after, and can never change or fail the events result.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = cronAuthFailure(request)
  if (denied) return denied

  const url = process.env.DATABASE_URL_OWNER
  if (!url) return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 })

  const client = new Client({ connectionString: url })
  // A dropped connection emits 'error' on the Client; with no listener that is an
  // uncaught exception that can take the function down. The in-flight query
  // rejects on its own and is reported through the series failure path.
  client.on('error', (e) => console.error('[cron] generate-events connection error:', e.message))
  await client.connect()
  try {
    const summary = await runRecurringEvents(client)
    let printJobsPruned = 0
    try {
      printJobsPruned = await pruneOldPrintJobs(client)
    } catch (e) {
      console.error('[cron] print job retention failed:', e instanceof Error ? e.message : e)
    }
    // `summary.failures` carries the reason each failed series failed (series id +
    // message, no tenant data), so a 500 says what to fix, not just that it happened.
    return NextResponse.json({ ...summary, printJobsPruned }, { status: summary.failed > 0 ? 500 : 200 })
  } finally {
    await client.end().catch(() => {})
  }
}

export const GET = handle
export const POST = handle
