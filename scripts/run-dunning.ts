/**
 * Advances the subscription dunning lifecycle (AROS-113).
 *
 *   npm run billing:dunning
 *   # or: npx tsx --import ./scripts/server-only-hook.mjs scripts/run-dunning.ts
 *
 * ── WHY THIS IS A SCRIPT AND NOT AN HTTP CRON ENDPOINT ──────────────────────
 *
 * The same reason scripts/run-recurring-expenses.ts gives, and it has not
 * changed: this project has no scheduler — no cron route, no job table, no
 * queue, no CRON_SECRET. The ONE established pattern for scheduled work here is
 * a tsx script run as the OWNER role by a host scheduler
 * (scripts/refresh-reports.ts, scripts/run-recurring-expenses.ts). This follows
 * it exactly rather than inventing a second architecture.
 *
 * An HTTP endpoint would also have to invent an authentication scheme for
 * itself — a shared secret in a header, checked by hand — to stop the internet
 * suspending tenants. A script that only a shell with the owner database
 * credentials can run has no such surface.
 *
 * Run it HOURLY. The transitions are all "has this deadline passed?", so more
 * frequent runs simply notice sooner; every one of them is idempotent (see
 * below), and an hour is fine granularity against a seven-day grace period:
 *
 *   17 * * * * cd /srv/arena-os && npm run billing:dunning >> /var/log/arena-dunning.log 2>&1
 *
 * A daily schedule also works and suspends up to a day late. What must NOT
 * happen is not running it at all: without it, a business whose
 * `subscription.halted` webhook was dropped keeps its plan forever without
 * paying, and no suspended account is ever closed.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Runs as arena_owner, which is RLS-exempt, exactly like the migrations, the
 * report refresh and the recurring-expense generator: acting across every
 * tenant at once is an owner-level operation and there is no session to scope
 * it to. NOTHING is taken from a caller — no tenant id, no subscription id, no
 * date, no policy override. Every value is read from the database or from
 * lib/platform/billing/dunning-policy.ts. There is no HTTP surface to
 * authenticate and no argument to validate, because there are no arguments.
 *
 * No secret is printed. The platform Razorpay credentials are loaded inside
 * lib/platform/billing/credentials.ts when a cancellation needs to stop a
 * mandate, and never leave it.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * Safe to run twice, safe to run twenty times, safe to kill halfway:
 *
 *   * one transaction PER SUBSCRIPTION, so an interrupted run leaves each one
 *     either fully advanced or entirely untouched;
 *   * each transition is guarded by the status it moves FROM, both in the row
 *     lock and in the UPDATE's WHERE clause, so a second run finds nothing;
 *   * reminders are claimed by a unique index before they are sent, so a job
 *     running hourly cannot send the same warning twenty-four times a day;
 *   * the grace and suspension clocks are stamped once and never restarted.
 *
 * The guarantees live in lib/platform/billing/dunning.ts and in migration 0081,
 * not in this file. This is a thin runner: load env, call the function, print
 * what it did.
 */
import { loadEnv } from './env'

async function main() {
  // BEFORE importing anything that touches @/db — the pool reads
  // DATABASE_URL_OWNER at module load.
  loadEnv()

  if (!process.env.DATABASE_URL_OWNER) {
    throw new Error('DATABASE_URL_OWNER is not set in .env.local')
  }

  const { processDunning, DUNNING_POLICY } = await import('../lib/platform/billing/dunning')

  const started = Date.now()
  console.log(
    `→ dunning: ${DUNNING_POLICY.graceDays}-day grace, ` +
      `${DUNNING_POLICY.suspensionDays} days suspended before cancellation`,
  )

  const summary = await processDunning()

  for (const p of summary.problems) console.warn(`  ! ${p}`)

  console.log(
    `done — ${summary.examined} subscription(s) examined, ` +
      `${summary.remindersSent} notice(s) sent, ` +
      `${summary.suspended} suspended, ${summary.cancelled} cancelled, ` +
      `${summary.failed} failed (${Date.now() - started}ms)`,
  )

  // Non-zero ONLY if a subscription actually errored, so a scheduler alerts on
  // real failures and stays quiet on an ordinary "nothing was due" run. A
  // deferred gateway cancellation is a note, not a failure — it retries next
  // run by design.
  process.exit(summary.failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
