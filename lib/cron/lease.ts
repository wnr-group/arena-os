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
 * Take it for the job's budget plus a margin, and call renewLease() before each
 * unit of work so a unit that overruns cannot let a second run start.
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

/**
 * Push the lease's expiry out to at least now + ttlMs, only while `lease` is
 * still the holder. Returns false if it was lost (expired and taken over), so a
 * long job can stop instead of overlapping a newer run. Never shortens a lease.
 */
export async function renewLease(lease: Lease, ttlMs: number, db: DB = ownerDb): Promise<boolean> {
  const r = await db.execute(sql`
    update public.job_leases
       set held_until = greatest(held_until, now() + make_interval(secs => ${ttlMs / 1000}))
     where name = ${lease.name} and holder = ${lease.holder}
    returning holder`)
  return r.rows.length > 0
}

/** Free the lease early. Only the holder's own row is touched; never throws. */
export async function releaseLease(lease: Lease, db: DB = ownerDb): Promise<void> {
  await db
    .execute(sql`update public.job_leases set held_until = now() where name = ${lease.name} and holder = ${lease.holder}`)
    .catch(() => {})
}
