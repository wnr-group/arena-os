/**
 * Refreshes the cached Google Business Profile reviews for every connected
 * tenant (0106).
 *
 *   npm run reviews:sync
 *   # or: npx tsx --import ./scripts/server-only-hook.mjs scripts/sync-google-reviews.ts
 *
 * ── WHY THIS IS A SCRIPT AND NOT AN HTTP CRON ENDPOINT ──────────────────────
 *
 * The same reason scripts/run-dunning.ts and scripts/run-recurring-expenses.ts
 * give, and it has not changed: this project has no scheduler — no cron route,
 * no job table, no queue, no CRON_SECRET. The ONE established pattern for
 * scheduled work here is a tsx script run as the OWNER role by a host scheduler
 * (scripts/refresh-reports.ts, scripts/run-recurring-expenses.ts,
 * scripts/run-dunning.ts). This follows it exactly rather than inventing a
 * second architecture.
 *
 * An HTTP endpoint would also have to invent an authentication scheme for
 * itself — a shared secret in a header, checked by hand — to stop the internet
 * spending every tenant's Google quota. A script that only a shell with the
 * owner database credentials can run has no such surface.
 *
 * ── HOW OFTEN ───────────────────────────────────────────────────────────────
 *
 * HOURLY is plenty, and daily is defensible. Reviews change slowly, the
 * homepage reads a cache by design (lib/reviews/public.ts), and a review a few
 * hours old is not wrong in any way a visitor would notice — staleness is the
 * accepted trade that keeps the public page independent of Google being up:
 *
 *   43 * * * * cd /srv/arena-os && npm run reviews:sync >> /var/log/arena-reviews.log 2>&1
 *
 * Off the hour on purpose: nothing here is deadline-driven, so there is no
 * reason to pile it onto the same minute as the dunning and report jobs.
 *
 * Do NOT run it every few minutes. Business Profile quota is per CLOUD PROJECT
 * and this job walks every connected tenant sequentially, so a tight schedule
 * buys freshness nobody can see at the cost of a ceiling that matters.
 *
 * Not running it at all is also a real state, and a quiet one: the homepage
 * simply keeps showing whatever the last successful run cached, and a venue
 * that connected today never shows any reviews at all.
 *
 * ── OVERLAPPING RUNS ────────────────────────────────────────────────────────
 *
 * The sweep is sequential, so it gets slower as venues connect: one token
 * exchange plus up to 40 paginated calls each. Once it outlasts the schedule,
 * two runs overlap. The database survives that — the unique constraint plus ON
 * CONFLICT DO UPDATE cannot duplicate a row — but both runs spend the same
 * per-project Google quota on the same reviews, and they interleave
 * last_sync_attempt / last_sync_error so a failure can look like it recovered.
 *
 * So this process takes pg_try_advisory_lock on a DEDICATED client it holds for
 * its whole lifetime, and exits quietly (status 0) when a previous run still
 * holds it. A dedicated client because @/db is a connection POOL: a
 * session-level lock taken by one pooled statement would be released on a
 * different connection than the next statement borrows, so the lock would not
 * mean what it says.
 *
 * try, not plain pg_advisory_lock: a second run must SKIP, not queue up behind
 * the first and then immediately repeat the whole sweep. Session-level rather
 * than transaction-level so it survives every COMMIT inside the sweep, and is
 * released by the connection dropping even if this process is killed.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 *
 * Runs as arena_owner, which is RLS-exempt, exactly like the migrations, the
 * report refresh and the dunning job: reading across every tenant at once is an
 * owner-level operation and there is no session to scope it to. NOTHING is
 * taken from a caller — no tenant id, no account id, no location id, no token.
 * Every value is read from google_business_credentials. There is no HTTP
 * surface to authenticate and no argument to validate, because there are no
 * arguments.
 *
 * No secret is printed. Refresh tokens and client secrets are decrypted inside
 * lib/reviews/google-credentials.ts, held for the life of one fetch, and never
 * logged — and the sync stores only Google's own error MESSAGE in
 * last_sync_error, never a token or an Authorization header.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 *
 * Safe to run twice, safe to run twenty times, safe to kill halfway. The
 * guarantee is the unique index google_reviews_tenant_review_key on
 * (tenant_id, google_review_id), NOT anything in this file: every write is an
 * ON CONFLICT DO UPDATE against it, so a re-sync edits the row it already wrote
 * rather than appending a duplicate, and two runs racing on the same review
 * cannot both insert. An interrupted run leaves the reviews it had already
 * written in place and the next run rewrites them.
 *
 * Nothing is ever deleted here. A review the venue's owner removed on Google
 * stops being returned but keeps its cached row — pruning is a separate,
 * explicit decision and not one to make from a job that also has to tolerate a
 * half-failed page.
 *
 * ── WHAT COUNTS AS A FAILURE ────────────────────────────────────────────────
 *
 * A tenant with no credentials row, or one that saved an OAuth client but never
 * finished consent (refresh_token_encrypted is null), is NOT an error. Most
 * tenants will never connect at all — Business Profile API access needs an
 * application, a verified profile live 60+ days and a business website — so
 * "not connected" is the ordinary case and this job reports it as a count, not
 * a problem.
 *
 * A tenant whose sync actually failed is different: syncGoogleReviewsForTenant
 * records the message in last_sync_error and keeps going, so one venue's
 * revoked token never stops the loop, and the owner-facing settings screen
 * shows it without anybody reading this log.
 *
 * ── FIRST RUN ───────────────────────────────────────────────────────────────
 *
 * createGoogleReviewFetcher() has never been exercised against Google — this
 * project has no approved API quota and no verified consent screen, and neither
 * can be obtained by writing code (see lib/reviews/google-business-api.ts).
 * Everything around it is covered by scripts/test-google-business-reviews.ts
 * with an injected fake. So treat the first scheduled run as the test, and read
 * last_sync_error rather than assuming silence means success.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

/**
 * The advisory-lock key for the whole sweep. Arbitrary but FIXED — advisory
 * locks share one namespace per database, so it must not collide with another
 * job's. Nothing else in this project takes one today; keep any future keys
 * listed together.
 */
const SYNC_LOCK_KEY = 4207105

async function main() {
  // BEFORE importing anything that touches @/db — the pool reads
  // DATABASE_URL_OWNER at module load, so a static import at the top of this
  // file would build it with no password.
  loadEnv()

  if (!process.env.DATABASE_URL_OWNER) {
    throw new Error('DATABASE_URL_OWNER is not set in .env.local')
  }

  // Checked HERE rather than discovered per tenant. Without it every connected
  // venue fails identically on decrypting its refresh token, which reads in the
  // log like a fleet-wide Google outage and is really one missing variable.
  if (!process.env.PAYMENT_SETTINGS_ENCRYPTION_KEY) {
    throw new Error(
      'PAYMENT_SETTINGS_ENCRYPTION_KEY is not set; stored refresh tokens cannot be decrypted.',
    )
  }

  // Its own connection, held for the life of this process — see OVERLAPPING
  // RUNS above for why the pooled app connection cannot carry this lock.
  const lockClient = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await lockClient.connect()
  const { rows: lock } = await lockClient.query<{ got: boolean }>(
    'select pg_try_advisory_lock($1) as got',
    [SYNC_LOCK_KEY],
  )
  if (lock[0]?.got !== true) {
    console.log('skipped — a previous sync is still running')
    await lockClient.end()
    // Zero: an overlapping run is normal operation, not something to alert on.
    process.exit(0)
  }

  const { createGoogleReviewFetcher } = await import('../lib/reviews/google-business-api')
  const { syncAllGoogleReviews } = await import('../lib/reviews/sync')

  const started = Date.now()
  console.log('→ google reviews: syncing every connected tenant')

  try {
    // The real fetcher, with the real `fetch` and the real token exchange. The
    // parameter exists so the test suite can inject a fake; production passes
    // neither and gets both defaults.
    const results = await syncAllGoogleReviews(createGoogleReviewFetcher())

    const connected = results.filter((r) => r.connected)
    const failed = connected.filter((r) => r.error !== null)
    const synced = connected.reduce((sum, r) => sum + r.synced, 0)
    const skipped = connected.reduce((sum, r) => sum + r.skipped, 0)

    for (const r of failed) console.warn(`  ! ${r.tenantId}: ${r.error}`)

    console.log(
      `done — ${results.length} tenant(s) examined, ` +
        `${connected.length} connected, ` +
        `${results.length - connected.length} not connected, ` +
        `${synced} review(s) cached, ` +
        `${skipped} skipped, ` +
        `${failed.length} failed (${Date.now() - started}ms)`,
    )

    // Non-zero ONLY when a connected tenant actually errored, so a scheduler
    // alerts on a revoked token or a disabled API and stays quiet on an
    // ordinary run where nobody has connected anything.
    process.exit(failed.length === 0 ? 0 : 1)
  } finally {
    // Released explicitly so a long-lived runner does not hold it; the
    // connection dropping would release it anyway if this process is killed.
    await lockClient.query('select pg_advisory_unlock($1)', [SYNC_LOCK_KEY]).catch(() => {})
    await lockClient.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
