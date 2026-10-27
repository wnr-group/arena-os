import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'

/**
 * A lease on a named job, in job_leases (0166).
 *
 * Replaces a session-level pg_try_advisory_lock. That lock needs one connection
 * held for the whole job and one that survives to release it, neither of which a
 * transaction pooler guarantees — and a lock that is never released stops the job
 * running again without any error. A lease is two ordinary statements, and it
 * expires: a killed run delays the next by at most `ttlMs`.
 *
 * Take it for longer than the job can run (budget + a margin for the last unit of
 * work), because nothing renews it.
 */
export type Lease = { name: string; holder: string }

/** The lease, or null when another holder still has it. One atomic statement. */
export async function acquireLease(name: string, ttlMs: number, db: DB = ownerDb): Promise<Lease | null> {
  const holder = randomUUID()
  const r = await db.execute(sql`
    insert into public.job_leases (name, holder, held_until)
    values (${name}, ${holder}, now() + make_interval(secs => ${ttlMs / 1000}))
    on conflict (name) do update
       set holder = excluded.holder, held_until = excluded.held_until
     where public.job_leases.held_until < now()
    returning holder`)
  return r.rows.length > 0 ? { name, holder } : null
}

/** Free the lease early. Only the holder's own row is touched; never throws. */
export async function releaseLease(lease: Lease, db: DB = ownerDb): Promise<void> {
  await db
    .execute(sql`update public.job_leases set held_until = now() where name = ${lease.name} and holder = ${lease.holder}`)
    .catch(() => {})
}
