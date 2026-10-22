import { NextResponse, type NextRequest } from 'next/server'
import { releaseExpiredHolds } from '@/lib/booking/payment-hold'
import { cronAuthFailure } from '@/lib/cron/auth'

/**
 * Scheduler hook for releasing expired unpaid online-booking holds (M36 #4) —
 * the Vercel option next to scripts/release-expired-holds.ts.
 *
 * Machine-to-machine: no session, no tenant. Authentication is the shared
 * CRON_SECRET bearer check in lib/cron/auth.ts. The response is only a count —
 * never a booking, tenant or secret.
 *
 * Safe to call repeatedly or concurrently: releaseExpiredHolds claims each
 * booking with FOR UPDATE SKIP LOCKED and the webhook takes the same row lock.
 */
export const dynamic = 'force-dynamic'

async function handle(request: NextRequest): Promise<NextResponse> {
  const denied = cronAuthFailure(request)
  if (denied) return denied
  const { released } = await releaseExpiredHolds()
  return NextResponse.json({ released })
}

export const GET = handle
export const POST = handle
