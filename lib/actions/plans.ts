'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { ownerDb } from '@/db'
import { planEntitlements, plans, tenants, tenantSubscriptions } from '@/db/schema'
import { requirePlatformAdmin, PlatformError } from '@/lib/platform/guard'
import { lockTenantUsage } from '@/lib/platform/usage'
import { recordPlatformOverride } from '@/lib/platform/billing/audit'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import { addMonths } from '@/lib/utils/date'

/**
 * Platform-admin CRUD for the plan catalogue and its entitlements (M16).
 *
 * A sibling of lib/actions/platform.ts and identical in shape on purpose:
 * every export begins with requirePlatformAdmin() and then writes through
 * `ownerDb`. That is the ONLY write path to these tables — `arena_app`, the
 * role every tenant request runs as, holds SELECT and nothing else on all
 * three (see the grants in migration 0079), so a tenant user cannot reach a
 * write here even if an action were somehow invoked without its guard.
 *
 * Deliberately NOT in lib/actions/platform.ts: that file is company
 * provisioning and membership, and the two will grow in different directions.
 *
 * Scope note — this ticket is the MODEL. There is no checkout, no gateway call,
 * no renewal and no upgrade/downgrade flow here, and nothing in the app reads
 * entitlements to block a feature. assignPlan() below exists only so an
 * operator can put a tenant on a plan by hand and the reader has something real
 * to return.
 */

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof PlatformError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  if (code === '23505') {
    // THREE different unique rules reach here: the catalogue name (0079), the
    // gateway plan mapping (0080), and the one-live-subscription-per-tenant
    // index (0079). Naming the wrong one sends an operator hunting for a
    // duplicate plan name that does not exist — which is exactly what a
    // concurrent assignPlan(), or an assignment racing a self-serve checkout,
    // used to report.
    if (constraint?.startsWith('idx_plans_gateway')) {
      return {
        error: 'That Razorpay plan is already mapped to another Arena OS plan.',
      }
    }
    if (constraint === 'idx_tenant_subscriptions_one_live') {
      return {
        error:
          'This company’s subscription was changed by someone else a moment ago. Reload the page and try again.',
      }
    }
    return { error: 'A plan with that name already exists.' }
  }
  if (code === '23503') return { error: 'That plan or tenant no longer exists.' }
  // The check constraints in 0079: a malformed entitlement key, a non-scalar
  // value, or a period that ends before it starts.
  if (code === '23514') return { error: 'That value is not allowed for this field.' }
  console.error('[plans] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// ── plans ────────────────────────────────────────────────────────────────────

/** Rupees at two decimals, matching numeric(10,2) and the >= 0 check in 0079. */
const money = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'Enter an amount like 2999 or 2999.00')

const planInput = z.object({
  name: z.string().trim().min(1, 'Plan name is required').max(60),
  monthlyPrice: money,
  annualPrice: money,
  // LETTERS, not just three characters. `length(3)` alone accepted "A1B" and
  // "12$", which the 0079 check (`length(currency) = 3`) also lets through —
  // and Intl.NumberFormat throws RangeError on a malformed code, so one such
  // row rendered every billing screen unusable. ISO 4217 codes are alphabetic.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. INR or USD')
    .default('INR'),
})

export async function createPlan(input: z.input<typeof planInput>): Promise<Result & { id?: string }> {
  try {
    await requirePlatformAdmin()
    const v = planInput.parse(input)
    const [row] = await ownerDb.insert(plans).values(v).returning({ id: plans.id })
    revalidatePath('/admin/plans')
    return { id: row.id }
  } catch (e) {
    return fail(e)
  }
}

export async function updatePlan(id: string, input: z.input<typeof planInput>): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = planInput.parse(input)
    await ownerDb.update(plans).set(v).where(eq(plans.id, id))
    revalidatePath('/admin/plans')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Retire or reinstate a plan.
 *
 * There is no deletePlan(). A plan is referenced by every subscription ever
 * taken on it, the FK is ON DELETE RESTRICT, and a deleted plan would make a
 * past invoice unexplainable. Retiring hides it from the catalogue while
 * existing subscribers keep everything it grants — which is exactly what policy
 * `plans_select_subscribed` in 0079 is there to allow.
 */
export async function setPlanActive(id: string, active: boolean): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await ownerDb.update(plans).set({ active }).where(eq(plans.id, id))
    revalidatePath('/admin/plans')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── gateway mapping (M16 #3, migration 0080) ─────────────────────────────────

/**
 * A Razorpay plan reference (`plan_…`). Shape-checked only — the alphabet after
 * the prefix is not contractual, so a stricter regex would reject legitimate
 * ids. Blank normalises to null, which means "this period cannot be billed".
 */
const gatewayPlanId = z
  .string()
  .trim()
  .max(100, 'That plan ID is too long.')
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))

const gatewayInput = z.object({
  gatewayMonthlyPlanId: gatewayPlanId,
  gatewayAnnualPlanId: gatewayPlanId,
})

/** The only provider this build speaks. Stored explicitly, never assumed. */
const PLATFORM_GATEWAY = 'razorpay'

/**
 * Point an Arena OS plan at its Razorpay Subscription plans.
 *
 * One Arena OS plan maps to TWO Razorpay plans because monthly_price and
 * annual_price are two different prices and a Razorpay plan object carries its
 * own amount. Both are stored explicitly and neither is derived from the other:
 * subscribeTenantToPlan() reads the column matching the requested period and
 * refuses when it is null, with no fallback, so "accidentally billed annually"
 * has no code path to travel down.
 *
 * ── The three collision checks, and which one lives where ───────────────────
 *
 *   monthly ≠ annual ON THIS PLAN        → CHECK plans_gateway_ids_distinct (0080)
 *   no duplicate WITHIN a column         → unique indexes (0080)
 *   no duplicate ACROSS the two columns  → HERE
 *
 * The third cannot be a plain unique index — it spans two columns of the same
 * row across different rows — so it is checked before the write. It is not
 * merely tidiness: if plan A's monthly id equalled plan B's annual id, a
 * `subscription.charged` webhook could not say which Arena OS plan had been
 * paid for.
 *
 * Note what this action does NOT do: it does not verify the ids against
 * Razorpay. That check belongs at the moment of charging and lives in
 * subscribeTenantToPlan(), which fetches the gateway plan and refuses to create
 * a subscription whose price does not match this catalogue. Doing it here as
 * well would make the admin form depend on a live gateway connection to save a
 * text field.
 */
export async function setPlanGateway(
  id: string,
  input: z.input<typeof gatewayInput>,
): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = gatewayInput.parse(input)

    const requested = [v.gatewayMonthlyPlanId, v.gatewayAnnualPlanId].filter(
      (x): x is string => x !== null,
    )

    if (requested.length > 0) {
      const others = await ownerDb
        .select({
          id: plans.id,
          name: plans.name,
          monthly: plans.gatewayMonthlyPlanId,
          annual: plans.gatewayAnnualPlanId,
        })
        .from(plans)
        .where(eq(plans.gateway, PLATFORM_GATEWAY))

      for (const other of others) {
        if (other.id === id) continue
        const clash = requested.find((r) => r === other.monthly || r === other.annual)
        if (clash) {
          return {
            error: `That Razorpay plan is already mapped to the ${other.name} plan. Each Razorpay plan may back only one Arena OS plan.`,
          }
        }
      }
    }

    await ownerDb
      .update(plans)
      .set({
        // The gateway is cleared alongside the ids: an id with no gateway is
        // unusable, and 0080's plans_gateway_ids_need_gateway would reject it.
        gateway: requested.length > 0 ? PLATFORM_GATEWAY : null,
        gatewayMonthlyPlanId: v.gatewayMonthlyPlanId,
        gatewayAnnualPlanId: v.gatewayAnnualPlanId,
      })
      .where(eq(plans.id, id))

    revalidatePath('/admin/plans')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── entitlements ─────────────────────────────────────────────────────────────

/**
 * The value half of an entitlement, parsed from what the admin form typed.
 *
 * Accepts exactly the four JSON scalars the check constraint in 0079 permits,
 * and nothing else. 'unlimited' maps to null deliberately: a limit of null is
 * "no ceiling", which must stay distinguishable from 0 ("none allowed").
 */
const entitlementValue = z.union([
  z.object({ type: z.literal('number'), number: z.number().finite() }),
  z.object({ type: z.literal('boolean'), boolean: z.boolean() }),
  z.object({ type: z.literal('string'), string: z.string().max(200) }),
  z.object({ type: z.literal('unlimited') }),
])

function toJson(v: z.infer<typeof entitlementValue>): number | boolean | string | null {
  switch (v.type) {
    case 'number':
      return v.number
    case 'boolean':
      return v.boolean
    case 'string':
      return v.string
    case 'unlimited':
      return null
  }
}

const entitlementInput = z.object({
  planId: z.string().uuid(),
  // Same shape the database check enforces, stated here so the form reports it
  // as a validation message rather than as a 23514.
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
      'Use lowercase words, e.g. max_branches or module.payroll',
    ),
  value: entitlementValue,
})

/**
 * Set one entitlement on one plan — insert or overwrite.
 *
 * Upsert rather than separate add/edit actions: `unique (plan_id, key)` already
 * says a key has exactly one value per plan, so "set it to this" is the only
 * operation the model admits, and two actions would just be two ways to race
 * each other.
 */
export async function setPlanEntitlement(
  input: z.input<typeof entitlementInput>,
): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = entitlementInput.parse(input)

    await ownerDb
      .insert(planEntitlements)
      .values({ planId: v.planId, key: v.key, value: toJson(v.value) })
      .onConflictDoUpdate({
        target: [planEntitlements.planId, planEntitlements.key],
        set: { value: toJson(v.value), updatedAt: new Date() },
      })

    revalidatePath('/admin/plans')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Remove an entitlement key from a plan.
 *
 * Note what this means to the reader: the key simply stops appearing in
 * getEntitlements(). It does NOT become false or zero — an absent key means
 * "this plan says nothing about that", and it is the enforcement story's job to
 * decide the default for a key it does not find.
 */
export async function removePlanEntitlement(id: string): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await ownerDb.delete(planEntitlements).where(eq(planEntitlements.id, id))
    revalidatePath('/admin/plans')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── putting a tenant on a plan ───────────────────────────────────────────────

const assignInput = z.object({
  tenantId: z.string().uuid(),
  planId: z.string().uuid(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
  /**
   * Months of runway from now — LITERAL months, whatever `billingPeriod` says.
   * `months: 12` is twelve months on an annual plan exactly as it is on a
   * monthly one. See assignPlan() for why this is not multiplied.
   *
   * Optional rather than defaulted here, because the default depends on
   * `billingPeriod` and Zod resolves field defaults independently. Omitted
   * means "one billing cycle" — resolved in DEFAULT_MONTHS below.
   */
  months: z.number().int().min(1).max(36).optional(),
  status: z.enum(['trialing', 'active']).default('active'),
})

/**
 * Runway when the caller does not say: ONE BILLING CYCLE.
 *
 * A business assigned an annual plan has bought a year, so defaulting it to one
 * month would expire its entitlements eleven months early. This is the only
 * place the twelve lives — it is a default, not a multiplier applied to
 * whatever the operator typed.
 */
const DEFAULT_MONTHS = { monthly: 1, annual: 12 } as const

/**
 * Assign (or replace) a tenant's subscription, by hand, from platform admin.
 *
 * This is NOT the subscription lifecycle — there is no payment, no gateway
 * object and no renewal. It is the operator action that makes the model usable
 * today, and the seam the billing story will grow into.
 *
 * The existing live row is closed out to 'cancelled' in the SAME transaction as
 * the new one is opened, because `idx_tenant_subscriptions_one_live` permits
 * only one live subscription per tenant — doing it in two statements outside a
 * transaction would fail on the index half the time and leave the tenant with
 * no plan the other half.
 */
export async function assignPlan(input: z.input<typeof assignInput>): Promise<Result> {
  try {
    // The actor, from the SESSION. AROS-114 §9 requires every manual override
    // to name who performed it, and this is the change-plan override — the
    // audit entry is written inside the transaction below rather than a second
    // plan-change path being created for the billing dashboard.
    const admin = await requirePlatformAdmin()
    const v = assignInput.parse(input)

    const now = new Date()
    // ── how long this assignment runs for ─────────────────────────────────
    //
    // `months` is LITERAL. It used to be multiplied by twelve for an annual
    // plan, which made the unit silently depend on `billingPeriod`: an operator
    // asking for twelve months of runway on an annual plan got twelve YEARS,
    // and the field's own documentation said "months". Nothing passed it
    // explicitly, so the trap had not fired — every caller relied on the
    // default, where 1 × 12 was the right answer for the wrong reason.
    //
    // Splitting the two ideas apart keeps that right answer and removes the
    // trap: the cycle length is a DEFAULT (DEFAULT_MONTHS above), and anything
    // the caller states is taken at face value.
    const months = v.months ?? DEFAULT_MONTHS[v.billingPeriod]
    // addMonths(), not setMonth(): assigning a one-month plan on 31 August
    // would otherwise ask for 31 September, which JavaScript resolves FORWARD
    // to 1 October — a day of free access past the intended end, and in the
    // wrong calendar month. current_period_end is what readEntitlements()
    // checks the clock against, so that day is real. The helper clamps to the
    // last valid day of the target month; it is the same one customer
    // membership expiry has always used.
    const end = addMonths(now, months)

    const gatewayConflict = await ownerDb.transaction(async (tx) => {
      // ── serialise every subscription change for this tenant ──────────────
      //
      // idx_tenant_subscriptions_one_live is a PARTIAL unique index, so it
      // constrains rows that exist and locks nothing when none do. Two
      // concurrent assignments — or an assignment racing a self-serve checkout
      // — therefore both read "no live row", both close nothing, and both
      // insert; one gets a 23505 and the operator gets an error about a
      // duplicate plan NAME.
      //
      // The advisory lock is the same one lib/platform/usage.ts takes before a
      // limit check, deliberately: a plan change and a "may I add one more
      // resource?" question are both decisions about this tenant's plan, and
      // holding one lock for both means they cannot interleave either.
      await lockTenantUsage(tx, v.tenantId)

      // A live row backed by a REAL Razorpay mandate must not be replaced from
      // here (M16 #3). This action only rewrites local rows; the mandate would
      // survive and keep charging the business for a plan it is no longer on,
      // and the operator would have no signal that it had happened. Cancelling
      // it is a deliberate act with its own path —
      // lib/platform/billing/cancel.ts — so this refuses and says so rather
      // than quietly creating a billing dispute.
      //
      // Inside the lock, so a checkout that completes between the check and the
      // writes cannot slip a mandate past it.
      const [gatewayBacked] = await tx
        .select({ ref: tenantSubscriptions.gatewaySubscriptionId })
        .from(tenantSubscriptions)
        .where(
          and(
            eq(tenantSubscriptions.tenantId, v.tenantId),
            inArray(tenantSubscriptions.status, ['trialing', 'active', 'past_due']),
            isNotNull(tenantSubscriptions.gatewaySubscriptionId),
          ),
        )
        .limit(1)

      if (gatewayBacked) return true

      // The outgoing state, read BEFORE it is closed, so the audit entry's
      // `before` is what the row actually was rather than a restatement of the
      // request. Null when this is a first assignment.
      const [previous] = await tx
        .select({
          id: tenantSubscriptions.id,
          planId: tenantSubscriptions.planId,
          planName: plans.name,
          billingPeriod: tenantSubscriptions.billingPeriod,
          status: tenantSubscriptions.status,
          currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
        })
        .from(tenantSubscriptions)
        .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
        .where(
          and(
            eq(tenantSubscriptions.tenantId, v.tenantId),
            inArray(tenantSubscriptions.status, ['trialing', 'active', 'past_due']),
          ),
        )
        .limit(1)

      // Only a live row blocks the index; expired/cancelled history is left
      // exactly as it is, which is the point of keeping it.
      await tx
        .update(tenantSubscriptions)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(
          and(
            eq(tenantSubscriptions.tenantId, v.tenantId),
            inArray(tenantSubscriptions.status, ['trialing', 'active', 'past_due']),
          ),
        )

      const [created] = await tx
        .insert(tenantSubscriptions)
        .values({
          tenantId: v.tenantId,
          planId: v.planId,
          billingPeriod: v.billingPeriod,
          status: v.status,
          currentPeriodStart: now,
          currentPeriodEnd: end,
        })
        .returning({ id: tenantSubscriptions.id })

      const [target] = await tx
        .select({ name: plans.name })
        .from(plans)
        .where(eq(plans.id, v.planId))
        .limit(1)

      // ── reopen an account the dunning processor closed ────────────────────
      //
      // Assigning a plan restored every ENTITLEMENT and nothing else, so a
      // business rescued after non-payment got payroll and reports back while
      // `tenants.status` stayed 'suspended' — which is the column
      // public_tenant_by_slug() (0022) reads, so its public booking site stayed
      // dark, and the column readMix() (billing/metrics.ts) counts, so the
      // revenue dashboard still filed it under suspended. The operator got no
      // signal that a second, separate setCompanyStatus() was required, and
      // lib/platform/entitlement-guard.ts promised the opposite in as many
      // words: "re-assigning a plan restores everything immediately".
      //
      // ONLY from 'suspended', and only when the new plan is actually live.
      // 'cancelled' is deliberately left alone: that is an operator's own
      // decision about the business relationship, and reopening a closed
      // account stays a deliberate act with its own action — the same rule
      // subscribeTenantToPlan() applies when it refuses to sell to one.
      const [tenantRow] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, v.tenantId))
        .limit(1)

      const reopened =
        tenantRow?.status === 'suspended' && (v.status === 'active' || v.status === 'trialing')

      if (reopened) {
        await tx
          .update(tenants)
          .set({ status: 'active' })
          .where(and(eq(tenants.id, v.tenantId), eq(tenants.status, 'suspended')))
      }

      // ONE entry, in the SAME transaction as the two writes above, so a plan
      // change can never exist without a record of who made it (AROS-114 §9).
      // `entity_id` is the NEW subscription — the row that now governs the
      // account — and the old one is named inside `before`.
      await recordPlatformOverride(
        tx,
        { userId: admin.id, email: admin.email },
        {
          tenantId: v.tenantId,
          action: 'change_plan',
          entityType: 'tenant_subscription',
          entityId: created.id,
          before: previous
            ? {
                subscriptionId: previous.id,
                planId: previous.planId,
                planName: previous.planName,
                billingPeriod: previous.billingPeriod,
                status: previous.status,
                currentPeriodEnd: previous.currentPeriodEnd.toISOString(),
                tenantStatus: tenantRow?.status ?? null,
              }
            : { subscriptionId: null, planName: null, tenantStatus: tenantRow?.status ?? null },
          after: {
            subscriptionId: created.id,
            planId: v.planId,
            planName: target?.name ?? null,
            billingPeriod: v.billingPeriod,
            status: v.status,
            currentPeriodEnd: end.toISOString(),
            // The RESOLVED value, not the raw input: an omitted `months` is what most
            // assignments send, and an audit entry saying `null` would not record
            // how long the plan was actually granted for.
            months,
            // Recorded whether or not it moved, so the trail answers "did this
            // assignment reopen the account?" without a second lookup.
            tenantStatus: reopened ? 'active' : (tenantRow?.status ?? null),
          },
        },
      )

      return false
    })

    if (gatewayConflict) {
      return {
        error:
          'This company has a live Razorpay subscription. Cancel it first — assigning a plan here would leave the gateway charging them for the old one.',
      }
    }

    revalidatePath('/admin/plans')
    revalidatePath(`/admin/companies/${v.tenantId}`)
    return {}
  } catch (e) {
    return fail(e)
  }
}
