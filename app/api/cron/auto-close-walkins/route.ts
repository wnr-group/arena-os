import { NextResponse, type NextRequest } from 'next/server'
import { autoCloseOverdueWalkins } from '@/lib/booking/walkin-auto-close'
import { cronAuthFailure } from '@/lib/cron/auth'
import { acquireLease, releaseLease } from '@/lib/cron/lease'

/**
 * Manual/optional hook that closes forgotten open-tab walk-ins (0167) for venues
 * that turned on "Auto-close forgotten walk-ins". No longer scheduled in
 * vercel.json: reads of the live walk-in list sweep on demand instead (see
 * sweepOverdueWalkinsForTenant). Kept for manual runs and an external scheduler.
 *
 * Machine-to-machine: no session, no tenant. Authenticates with the shared
 * CRON_SECRET bearer check in lib/cron/auth.ts. The response is only counts —
 * never a booking or tenant. An expiring lease stops overlapping runs from
 * working the same bookings; checkout's row lock makes a race harmless anyway.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = cronAuthFailure(request)
  if (denied) return denied

  const lease = await acquireLease('auto-close-walkins', 5 * 60_000)
  if (!lease) return NextResponse.json({ skipped: true })
  try {
    const { closed, failed } = await autoCloseOverdueWalkins()
    return NextResponse.json({ closed, failed })
  } catch (e) {
    console.error('[cron] auto-close walk-ins failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Auto-close failed.' }, { status: 500 })
  } finally {
    await releaseLease(lease)
  }
}

export const GET = handle
export const POST = handle
