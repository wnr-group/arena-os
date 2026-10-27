import { NextResponse, type NextRequest } from 'next/server'
import { Client } from 'pg'
import { cronAuthFailure } from '@/lib/cron/auth'
import { runRecurringEvents } from '@/lib/events/recurring'

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
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = cronAuthFailure(request)
  if (denied) return denied

  const url = process.env.DATABASE_URL_OWNER
  if (!url) return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 })

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const summary = await runRecurringEvents(client)
    return NextResponse.json(summary, { status: summary.failed > 0 ? 500 : 200 })
  } finally {
    await client.end().catch(() => {})
  }
}

export const GET = handle
export const POST = handle
