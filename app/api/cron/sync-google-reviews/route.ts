import { NextResponse, type NextRequest } from 'next/server'
import { cronAuthFailure } from '@/lib/cron/auth'
import { runGoogleReviewSweep, summariseSweep } from '@/lib/reviews/sweep'

/**
 * Scheduler hook for the Google Business Profile review sync (0142) — the
 * Vercel option next to scripts/sync-google-reviews.ts, which runs the very
 * same sweep under the very same advisory lock.
 *
 * Machine-to-machine: no session, no tenant, no parameters. Authenticates with
 * the shared CRON_SECRET bearer check in lib/cron/auth.ts. The response is
 * counts only — never a tenant id, review, token or error message (those live
 * in google_business_credentials.last_sync_error for the owner to see).
 *
 * The sweep is sequential, so it takes longer as venues connect. If it outlasts
 * maxDuration the platform cuts the request; the next run simply repeats the
 * work, which is idempotent (ON CONFLICT DO UPDATE), and the advisory lock
 * stops overlapping runs from doubling the Google quota spend.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = cronAuthFailure(request)
  if (denied) return denied

  try {
    const outcome = await runGoogleReviewSweep()
    if (outcome.skipped) return NextResponse.json({ skipped: true })
    return NextResponse.json({ ...summariseSweep(outcome.results), ms: outcome.ms })
  } catch (e) {
    console.error('[cron] google review sync failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Sync failed.' }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
