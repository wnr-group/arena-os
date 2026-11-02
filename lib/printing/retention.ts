/**
 * Retention for the cloud-print queue. print_jobs rows carry the printer bytes
 * (up to ~32 KB each, MAX_JOB_BYTES) and nothing ever removed them.
 *
 * Only FINISHED jobs go: printed, cancelled, or failed (a failed job that nobody
 * retried or cancelled for the whole window is long past being actionable).
 * pending / sent jobs are never touched — they are still live, or surface as
 * stale in the queue for staff.
 *
 * Takes anything with a pg-style `query`, no 'server-only' — the same pattern as
 * lib/events/recurring.ts, so the daily cron and standalone scripts share it.
 */
export const PRINT_JOB_RETENTION_DAYS = 30

/** Rows removed per statement, so one sweep never holds a long lock. */
const BATCH = 2000
/** Upper bound per run (the next daily run continues if there is a backlog). */
const MAX_BATCHES = 25

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> }

export async function pruneOldPrintJobs(db: Queryable, days: number = PRINT_JOB_RETENTION_DAYS): Promise<number> {
  if (!Number.isInteger(days) || days < 1) throw new Error('Retention must be a whole number of days, at least 1.')
  let removed = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await db.query(
      `delete from public.print_jobs
        where id in (select id from public.print_jobs
                      where status in ('printed','cancelled','failed')
                        and created_at < now() - make_interval(days => $1)
                      order by created_at
                      limit ${BATCH})`,
      [days],
    )
    const n = r.rowCount ?? 0
    removed += n
    if (n < BATCH) break
  }
  return removed
}
