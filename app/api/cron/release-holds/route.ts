import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { releaseExpiredHolds } from '@/lib/booking/payment-hold'

/**
 * Scheduler hook for releasing expired unpaid online-booking holds (M36 #4) —
 * the Vercel option next to scripts/release-expired-holds.ts.
 *
 * Machine-to-machine: no session, no tenant. It authenticates with
 * `Authorization: Bearer ${CRON_SECRET}`, exactly the header Vercel Cron sends
 * when the CRON_SECRET env var is set. With the secret unset or empty the route
 * refuses to run at all (503) rather than falling open. The response is only a
 * count — never a booking, tenant or secret.
 *
 * Safe to call repeatedly or concurrently: releaseExpiredHolds claims each
 * booking with FOR UPDATE SKIP LOCKED and the webhook takes the same row lock.
 */
export const dynamic = 'force-dynamic'

function authorised(request: NextRequest, secret: string): boolean {
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  // timingSafeEqual throws on unequal lengths; a length mismatch is a plain "no".
  return given.length === want.length && timingSafeEqual(given, want)
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 })
  }
  if (!authorised(request, secret)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  const { released } = await releaseExpiredHolds()
  return NextResponse.json({ released })
}

export const GET = handle
export const POST = handle
