import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Shared guard for the machine-to-machine cron routes under app/api/cron.
 *
 * Authenticates with `Authorization: Bearer ${CRON_SECRET}`, exactly the header
 * Vercel Cron sends when the CRON_SECRET env var is set. With the secret unset
 * or blank the route refuses to run (503) rather than falling open.
 *
 * Returns a response to send back when the request must not proceed, or null
 * when it is authorised.
 */
export function cronAuthFailure(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  // A whitespace-only value is as good as unset: refuse rather than fall open.
  if (!secret?.trim()) {
    return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 })
  }
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  // timingSafeEqual throws on unequal lengths; a length mismatch is a plain "no".
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  return null
}
