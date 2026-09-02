import 'server-only'
import { cache } from 'react'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, withUser, type DB } from '@/db'
import { planEntitlements, plans, tenantSubscriptions } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { graceEndsAt } from './billing/dunning-policy'
import { requirePlatformAdmin } from './guard'

/**
 * "What is this tenant entitled to?" — the single reader for the plan a
 * business is on and the limits/modules that plan carries (M16).
 *
 * READ-ONLY, AND NOTHING ENFORCES IT YET. This ticket establishes the model and
 * this reader; no create path, guard or nav entry consults it. Enforcement is
 * the next story, and putting it here would spread plan checks through the app
 * before there is a single place to reason about them.
 *
 * ── The reader never hard-codes a key ───────────────────────────────────────
 *
 * `entitlements` is whatever rows exist for the plan, collapsed into an object.
 * There is no allow-list, no `if (key === 'max_branches')`, and no import of
 * lib/platform/plans/defaults.ts (which is seed data only). An operator adding
 * `module.website_builder` from the admin UI gets it back from here on the next
 * request with no code change — that is the whole point of entitlements being
 * rows instead of columns.
 */

/** A JSON scalar. The check constraint in 0070 is what keeps it flat. */
export type EntitlementValue = number | boolean | string | null

export type TenantEntitlements = {
  /** Null when the tenant has no live subscription at all. */
  plan: { id: string; name: string } | null
  billingPeriod: 'monthly' | 'annual' | null
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | null
  currentPeriodEnd: Date | null
  /** Empty when there is no live subscription. Never null. */
  entitlements: Record<string, EntitlementValue>
}

/** The empty answer, used for every "not entitled" case so they are identical. */
const NO_SUBSCRIPTION: TenantEntitlements = {
  plan: null,
  billingPeriod: null,
  status: null,
  currentPeriodEnd: null,
  entitlements: {},
}

/**
 * The statuses that can still be granting anything.
 *
 * Deliberately the SAME three the partial unique index in 0070
 * (idx_tenant_subscriptions_one_live) uses to permit at most one live
 * subscription per tenant. Keeping the two lists identical is what guarantees
 * this reader can never find two candidate rows and have to pick.
 *
 * `past_due` is included so a failed renewal does not revoke a business's
 * access the instant the charge bounces — dunning is supposed to be a
 * conversation, not a trapdoor. It still lapses on the clock below.
 *
 * ── AROS-113 finished that sentence ─────────────────────────────────────────
 *
 * The line above used to end "…and a deliberate grace window is expressed by
 * extending current_period_end, which belongs to the dunning story". The
 * dunning story arrived and REJECTED that mechanism, for a reason worth
 * recording: `current_period_end` is the period an invoice documents and
 * proration is computed from, so moving it to buy a business a few days'
 * grace would falsify a GST document.
 *
 * Worse, it would not have worked. A failed renewal leaves current_period_end
 * in the PAST — Razorpay does not extend a period it could not charge for — so
 * the clock check below would fail the instant the charge bounced, and
 * `past_due` being in LIVE_STATUSES would have granted nothing at all. The
 * trapdoor this list exists to prevent was, in fact, still open.
 *
 * So grace is a SEPARATE clock on a SEPARATE column: `past_due_since`
 * (migration 0073), read below. current_period_end keeps meaning exactly what
 * it always meant.
 */
const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const

/**
 * Effective entitlements over an ALREADY-OPENED transaction.
 *
 * Takes a `tx` rather than opening one, for the same reason readPortalBookings()
 * does: `cookies()` only exists inside a request, and the query is the part
 * worth testing. It works unchanged on a tenant-scoped connection (RLS decides
 * what is visible) and on the owner connection (nothing is hidden), which is
 * why both wrappers below can share it.
 *
 * ── The lapsed-but-still-'active' case ──────────────────────────────────────
 *
 * Status alone is not trusted. A renewal sweep that has not run yet leaves rows
 * saying 'active' with a current_period_end in the past, and treating those as
 * entitled would mean the plan quietly outlives the payment. So the rule is
 * status AND clock — exactly the rule this codebase already applies to customer
 * memberships (`m.status === 'active' && now < m.expiresAt`,
 * lib/memberships/customer-memberships.ts). One idea, one rule, stated twice
 * only because the two live in different modules.
 *
 * A RETIRED plan (active = false) still grants everything it lists. Grandfathering
 * is the normal reason to retire a plan rather than delete it, so there is no
 * filter on plans.active here — and policy `plans_select_subscribed` in 0070
 * exists precisely so the subscriber can still read it.
 */
export async function readEntitlements(tx: DB, tenantId: string): Promise<TenantEntitlements> {
  const [row] = await tx
    .select({
      planId: plans.id,
      planName: plans.name,
      billingPeriod: tenantSubscriptions.billingPeriod,
      status: tenantSubscriptions.status,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      pastDueSince: tenantSubscriptions.pastDueSince,
    })
    .from(tenantSubscriptions)
    .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
      ),
    )
    // The index above permits only one live row, so this orders a set of at
    // most one. It is here so a database that somehow held two (an index built
    // NOT VALID, a restore mid-migration) resolves deterministically to the
    // newest rather than to whatever the planner returned first.
    .orderBy(desc(tenantSubscriptions.currentPeriodStart))
    .limit(1)

  // No live subscription, or none this caller may see. Both give the same
  // empty answer — a tenant asking about another tenant learns nothing.
  if (!row) return NO_SUBSCRIPTION

  // ── expired on the clock even though the status has not caught up ─────────
  //
  // WHICH clock depends on whether the subscription is in arrears (AROS-113):
  //
  //   normally      current_period_end — the paid-for period.
  //   in past_due   the LATER of that and the grace deadline measured from
  //                 past_due_since. A failed renewal leaves current_period_end
  //                 in the past, so without this the grace period would be
  //                 zero and `past_due` would grant nothing — the exact
  //                 trapdoor the LIVE_STATUSES note above forbids.
  //
  // `Math.max` rather than a branch, so a subscription whose paid period
  // OUTLASTS its grace window (a mid-period failure on an annual plan) keeps
  // the access it paid for. Grace can only ever extend, never shorten.
  //
  // A `past_due` row with no `past_due_since` — possible only for a row written
  // before migration 0073 backfilled them, or by a future path that forgets to
  // stamp it — gets NO grace and falls back to the period end. That is the
  // fail-closed direction: an unknown clock grants nothing.
  //
  // The comparison is `<=`, i.e. access ends AT the deadline, not after it —
  // the same boundary rule graceHasExpired() applies from the other side. There
  // is therefore no instant in which the dunning job considers a tenant
  // suspended while this reader still grants it a plan.
  const effectiveEnd =
    row.status === 'past_due' && row.pastDueSince
      ? Math.max(row.currentPeriodEnd.getTime(), graceEndsAt(row.pastDueSince).getTime())
      : row.currentPeriodEnd.getTime()

  if (effectiveEnd <= Date.now()) return NO_SUBSCRIPTION

  const rows = await tx
    .select({ key: planEntitlements.key, value: planEntitlements.value })
    .from(planEntitlements)
    .where(eq(planEntitlements.planId, row.planId))

  const entitlements: Record<string, EntitlementValue> = {}
  for (const e of rows) {
    entitlements[e.key] = e.value as EntitlementValue
  }

  return {
    plan: { id: row.planId, name: row.planName },
    billingPeriod: row.billingPeriod,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    entitlements,
  }
}

/**
 * Effective entitlements for the signed-in staff member's own tenant.
 *
 * Takes an ActiveContext and runs under withUser(), the same shape as
 * getPnlReport() and every other staff-side reader. The tenant id comes from
 * the resolved context, never from a caller-supplied argument, and RLS
 * (tenant_subscriptions_select, 0070) independently confines the query to the
 * tenants this user is an active member of — so even a wrong id here could not
 * read somebody else's plan.
 */
export async function getEntitlements(ctx: ActiveContext): Promise<TenantEntitlements> {
  return cachedEntitlements(ctx.user.id, ctx.tenant.id)
}

/**
 * Memoised for the life of ONE request (React `cache`).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The layered design has each gated page ask this question several times: the
 * page calls hasEntitlement() to decide redirect-or-render, and then every
 * reader it invokes calls requireEntitlement() again because a reader must
 * never trust its caller. On /settings/payroll/runs that was THREE resolutions
 * — page gate, listPayrollPeriods(), listPayslipsForPeriod() — each opening its
 * own withUser() transaction (BEGIN, set_config, two SELECTs, COMMIT) for one
 * boolean, on every navigation.
 *
 * Caching removes the repetition WITHOUT removing a single guard: each call
 * still runs, still throws, and still cannot be skipped by a caller. Only the
 * database round-trip is shared.
 *
 * ── Keyed on ids, not on the context object ─────────────────────────────────
 *
 * `cache()` compares arguments by identity, so passing `ctx` would dedupe only
 * when every caller happened to hold the same object. The two ids are the whole
 * key, and they are primitives.
 *
 * ── Scope, deliberately ─────────────────────────────────────────────────────
 *
 * Only this path — the one that opens its OWN transaction. readEntitlements()
 * stays uncached because requireEntitlementIn() must read inside the caller's
 * transaction, where an in-flight write has to be visible. A request that
 * changes a subscription and re-reads entitlements afterwards therefore still
 * sees the change through that path; this one holds a value for the request,
 * which is the correct lifetime for "what plan is this tenant on".
 */
const cachedEntitlements = cache(
  async (userId: string, tenantId: string): Promise<TenantEntitlements> =>
    withUser(userId, (tx) => readEntitlements(tx, tenantId)),
)

/**
 * The same answer for ANY tenant, for the platform admin surface.
 *
 * Cross-tenant by design and therefore on the owner connection, so it enforces
 * the platform-admin check itself rather than trusting a page guard — the rule
 * lib/platform/data.ts states and every reader in it follows.
 */
export async function getTenantEntitlements(tenantId: string): Promise<TenantEntitlements> {
  await requirePlatformAdmin()
  return readEntitlements(ownerDb, tenantId)
}
