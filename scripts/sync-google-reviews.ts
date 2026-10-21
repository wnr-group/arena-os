/**
 * Refreshes the cached Google Business Profile reviews for every connected
 * tenant (0142).
 *
 *   npm run reviews:sync
 *   # or: npx tsx --import ./scripts/server-only-hook.mjs scripts/sync-google-reviews.ts
 *
 * ── TWO WAYS TO SCHEDULE IT ─────────────────────────────────────────────────
 *
 * This script is for a host scheduler (the pattern scripts/run-dunning.ts and
 * scripts/run-recurring-expenses.ts follow). On Vercel the same sweep runs from
 * app/api/cron/sync-google-reviews, guarded by CRON_SECRET and scheduled in
 * vercel.json. Both call runGoogleReviewSweep() in lib/reviews/sweep.ts, so they
 * share ONE advisory lock and cannot overlap each other. Use one or the other,
 * not both on a tight schedule.
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
 * The sweep is sequential, so it gets slower as venues connect. Once it
 * outlasts the schedule two runs would overlap and spend the same per-project
 * Google quota twice. runGoogleReviewSweep() takes pg_try_advisory_lock on a
 * dedicated client and reports `skipped` when a previous run holds it; this
 * script then exits quietly with status 0.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 *
 * Runs as arena_owner, which is RLS-exempt, exactly like the migrations, the
 * report refresh and the dunning job: reading across every tenant at once is an
 * owner-level operation and there is no session to scope it to. NOTHING is
 * taken from a caller — no tenant id, no account id, no location id, no token.
 * Every value is read from google_business_credentials. This script has no
 * arguments to validate; the Vercel route that runs the same sweep takes none
 * either and is guarded by the CRON_SECRET bearer check (lib/cron/auth.ts).
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
import { loadEnv } from './env'

async function main() {
  // BEFORE importing anything that touches @/db — the pool reads
  // DATABASE_URL_OWNER at module load, so a static import at the top of this
  // file would build it with no password.
  loadEnv()

  const { runGoogleReviewSweep, summariseSweep } = await import('../lib/reviews/sweep')

  console.log('→ google reviews: syncing every connected tenant')
  const outcome = await runGoogleReviewSweep()

  if (outcome.skipped) {
    console.log('skipped — a previous sync is still running')
    // Zero: an overlapping run is normal operation, not something to alert on.
    process.exit(0)
  }

  const t = summariseSweep(outcome.results)
  for (const r of outcome.results.filter((x) => x.connected && x.error !== null)) {
    console.warn(`  ! ${r.tenantId}: ${r.error}`)
  }
  console.log(
    `done — ${t.examined} tenant(s) examined, ${t.connected} connected, ` +
      `${t.notConnected} not connected, ${t.synced} review(s) cached, ` +
      `${t.skipped} skipped, ${t.failed} failed (${outcome.ms}ms)`,
  )

  // Non-zero ONLY when a connected tenant actually errored, so a scheduler
  // alerts on a revoked token or a disabled API and stays quiet on an
  // ordinary run where nobody has connected anything.
  process.exit(t.failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
