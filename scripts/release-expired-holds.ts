/**
 * Releases unpaid online-booking holds (M36 #4).
 *
 *   npm run bookings:release-holds
 *   # or: npx tsx --import ./scripts/server-only-hook.mjs scripts/release-expired-holds.ts
 *
 * Follows the project's one scheduling convention (see scripts/run-dunning.ts):
 * a tsx script run as the OWNER role by a host scheduler. Run it every minute:
 *
 *   * * * * * cd /srv/arena-os && npm run bookings:release-holds >> /var/log/arena-holds.log 2>&1
 *
 * Idempotent and safe to overlap: each booking is claimed with FOR UPDATE SKIP
 * LOCKED, and the Razorpay webhook takes the same row lock. The public booking
 * actions also release a tenant's expired holds on demand, so a late or missed
 * run delays cleanup but never blocks a customer.
 *
 * On Vercel (no host crontab) use the route instead: GET/POST
 * /api/cron/release-holds with `Authorization: Bearer $CRON_SECRET`
 * (app/api/cron/release-holds/route.ts; Vercel Cron sends that header itself
 * once CRON_SECRET is set and a cron is declared in vercel.json).
 */
import { loadEnv } from './env'

loadEnv()

async function main() {
  const { releaseExpiredHolds } = await import('../lib/booking/payment-hold')
  const { released } = await releaseExpiredHolds()
  console.log(`[release-holds] released ${released} expired unpaid hold(s)`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[release-holds] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
