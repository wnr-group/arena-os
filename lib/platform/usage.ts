import 'server-only'
import { and, count, eq, sql } from 'drizzle-orm'
import type { DB } from '@/db'
import { branches, memberships, resources } from '@/db/schema'

/**
 * What a tenant is currently USING, for the limit checks in
 * ./entitlement-guard.ts (M16 #2).
 *
 * ── Every count is taken server-side, in the caller's transaction ───────────
 *
 * Each of these takes the `tx` the write is about to happen in, so the number
 * checked against the plan and the number the insert changes come from the same
 * RLS-scoped transaction. A count passed in from the browser would make the
 * limit a suggestion; a count read on a separate connection would leave a
 * window in which two concurrent creates both see "one under the limit".
 *
 * ── Counting is not enough on its own: take the lock first ──────────────────
 *
 * These are plain SELECT counts, so on their own they are a check-then-act: two
 * requests both read "one under the limit" and both write. This file used to
 * record that as an accepted risk, on the grounds that "the overshoot is one
 * item… a billing conversation rather than a security failure".
 *
 * That was measured and it was wrong. scripts/test-m16-limit-race.ts holds
 * eight concurrent requests at the check and releases them together: on a plan
 * capped at 3 staff, all eight were admitted and the tenant finished with 10.
 * The overshoot is not a constant — it is the CONCURRENCY, so a plan limit
 * could be exceeded by as much as a caller cared to parallelise. That is not a
 * billing conversation, it is the limit not existing.
 *
 * So every write path that enforces a limit MUST call lockTenantUsage() before
 * it counts. The lock is transaction-scoped, so the count, the check and the
 * insert are serialised per tenant and the window closes. Counting without it
 * is only safe for DISPLAY, which is why the lock is a separate call rather
 * than being folded into the counters — the billing portal renders "2 of 3
 * used" on a read-only page and must not take write locks to do it.
 *
 * The `tenant_id` predicates are belt-and-braces beside RLS: correct on their
 * own terms, and they keep the count on an index.
 */

/**
 * Serialise this tenant's limit checks for the rest of the transaction.
 *
 * A transaction-scoped ADVISORY lock, not a row lock: there is no single row
 * that all limits belong to (a tenant with no subscription still has to be
 * refused, and `for update` on nothing locks nothing), and advisory locks are
 * released automatically on commit or rollback with no row to contend over.
 *
 * Keyed on the tenant id alone rather than on (tenant, key). Two DIFFERENT
 * limits for one tenant will briefly queue behind each other, which costs
 * microseconds and removes any question of a call site picking the wrong key.
 * Different tenants never contend.
 *
 * `hashtextextended` gives the bigint the lock function wants. A hash collision
 * between two tenants would only ever mean one waits for the other — never a
 * missed lock — so the pigeonhole is harmless here.
 */
export async function lockTenantUsage(tx: DB, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`)
}

/**
 * Branches this tenant has.
 *
 * ── Not wired to anything yet, and that is not an oversight ─────────────────
 *
 * `max_branches` has NO enforcement point, because the app has no tenant-facing
 * way to create a branch. The only INSERT into `branches` outside seeds is in
 * createCompany() (lib/actions/platform.ts), where a platform admin provisions
 * a new tenant's single "Main Branch" — gating that against the new tenant's
 * own plan would be circular, since the tenant has no subscription until after
 * it exists.
 *
 * So this counter is the half that can be written now. When a branch-creation
 * action lands, the whole gate is three lines inside its transaction — and the
 * FIRST of them is the lock, for the reason given at the top of this file:
 *
 *     await lockTenantUsage(tx, ctx.tenant.id)
 *     await checkLimitIn(tx, ctx.tenant.id, 'max_branches',
 *       await countBranches(tx, ctx.tenant.id), { one: 'branch', many: 'branches' })
 *     // …then the insert, in this same transaction.
 *
 * Written and tested here (scripts/verify-entitlement-enforcement.ts drives it
 * directly) so that story inherits a proven check rather than a fresh one.
 */
export async function countBranches(tx: DB, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(branches)
    .where(eq(branches.tenantId, tenantId))
  return row?.n ?? 0
}

/**
 * Staff SEATS in use — `active` memberships only.
 *
 * member_status is ('invited','active','disabled') (0001). A `disabled` row is
 * a former employee kept for history — payslips and audit entries reference it
 * — so counting those would shrink a plan over time for reasons the business
 * cannot undo without destroying records. `invited` is not counted either: it
 * is someone who has not joined, and today nothing writes it (inviteStaff()
 * creates members as 'active' directly).
 */
export async function countActiveStaff(tx: DB, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')))
  return row?.n ?? 0
}

/**
 * Bookable resources this tenant has.
 *
 * ALL of them, including those parked at 'maintenance' or 'inactive': a
 * resource is a thing the venue owns and the plan is sizing the venue, not
 * today's availability. Counting only 'available' ones would also hand every
 * tenant a trivial way around the cap — park one, add another.
 */
export async function countResources(tx: DB, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(resources)
    .where(eq(resources.tenantId, tenantId))
  return row?.n ?? 0
}
