import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { tenantSubscriptions } from '@/db/schema'
import { provisionTenant, type TenantIndustry } from '@/lib/platform/provision'
import { getPublicPlan } from '@/lib/platform/plans/public'
import { subscribeTenantToPlan, SubscriptionError } from '@/lib/platform/billing/subscribe'
import { LIVE_STATUSES } from '@/lib/platform/billing/lifecycle'
import { slugProblem, slugProblemMessage } from '@/lib/platform/slug'
import { pgError } from '@/lib/utils/errors'

/**
 * Self-serve signup (M16 #6) — a business creating its own Arena OS workspace.
 *
 * ══ WHAT THIS MODULE IS AND IS NOT ═════════════════════════════════════════
 *
 * It is an ORCHESTRATOR. Every step it performs already existed and is called,
 * not reimplemented:
 *
 *   provisionTenant()        lib/platform/provision.ts — the SAME transaction
 *                            createCompany() uses. Tenant, Main Branch, owner
 *                            membership, starter expense categories.
 *   subscribeTenantToPlan()  lib/platform/billing/subscribe.ts — the SAME
 *                            Razorpay Subscriptions path the owner billing
 *                            portal uses, including the check that the gateway
 *                            plan charges what the catalogue advertises.
 *   getPublicPlan()          the RLS-scoped catalogue read, so a retired plan
 *                            cannot be subscribed to by posting its id.
 *
 * There is no second provisioning flow, no second Razorpay call, no second
 * subscription writer for the paid path, and no new authentication.
 *
 * ══ THE CHOSEN CONSISTENCY MODEL ═══════════════════════════════════════════
 *
 * The existing architecture already decided this and it is followed rather than
 * re-litigated: subscribeTenantToPlan() creates the gateway subscription first,
 * records a LOCAL row as `trialing` — live but unpaid, with a short pending
 * window — and lets the verified webhook promote it to `active`. Returning from
 * Razorpay's page proves nothing.
 *
 * So signup provisions in this order:
 *
 *   1. validate everything (business, slug shape, plan)
 *   2. provisionTenant()            → the workspace exists, account = 'trial'
 *   3. attach a plan
 *        trial → a local `trialing` subscription, no gateway object at all
 *        paid  → subscribeTenantToPlan() → gateway subscription + checkout URL
 *   4. the owner signs in at their own subdomain and finishes payment if needed
 *
 * The account is 'trial' in BOTH cases at the end of signup, because in both
 * cases nobody has paid yet. lib/platform/billing/lifecycle.ts moves it to
 * 'active' when a charge actually lands.
 *
 * ── The failure modes this leaves, stated rather than hidden ────────────────
 *
 * "Payment succeeded but the tenant was never provisioned" is impossible: the
 * tenant is provisioned before Razorpay is ever contacted, so there is nothing
 * to charge until it exists.
 *
 * "Tenant created but subscription never attached" IS reachable — if the
 * gateway call in step 3 fails, the workspace exists with no plan. That is
 * deliberately not rolled back. The owner account is real, the password they
 * just chose works, and lib/platform/billing/portal.ts is an existing, fully
 * built billing portal whose entire purpose is choosing a plan. So the flow
 * returns `provisioned: true` with a `planError`, and the UI sends them to sign
 * in and finish there. Deleting a workspace to hide a gateway blip would be the
 * worse trade: it destroys the owner's account and their chosen slug, and it
 * cannot be done safely anyway once Razorpay may already hold a subscription
 * object for it.
 *
 * "A retry created a second tenant / owner / subscription" cannot happen:
 *   * tenant  — `tenants.slug` is NOT NULL UNIQUE (0001). A concurrent or
 *               repeated submission with the same slug loses at the index, and
 *               that 23505 is translated into "not available" rather than a
 *               500. The availability check is a courtesy; THIS is the rule.
 *   * owner   — findOrCreateUser() is keyed on email, so a retry reuses the
 *               existing user rather than creating a second one.
 *   * plan    — idx_tenant_subscriptions_one_live (0070) permits exactly one
 *               live subscription per tenant, and attachTrialSubscription()
 *               below refuses outright if one already exists.
 */

export class SignupError extends Error {
  constructor(
    message: string,
    /** Which field to attach this to in the form, when there is one. */
    readonly field?: 'slug' | 'ownerEmail' | 'planId' | null,
  ) {
    super(message)
    this.name = 'SignupError'
  }
}

/**
 * How long a self-serve trial runs.
 *
 * A NEW number: nothing in the existing codebase defined a trial length —
 * assignPlan() takes an explicit `periodMonths` from the operator, and
 * subscribeTenantToPlan()'s three-day window is a pending-authorisation
 * allowance, not a trial. Fourteen days is the ordinary SaaS convention and is
 * long enough to set a venue up and take real bookings through it.
 *
 * It is a constant rather than a per-plan column on purpose: adding a
 * `trial_days` column to `plans` would be a schema change this ticket does not
 * need, and an operator who wants a different length for one customer already
 * has assignPlan() to set any period they like.
 */
export const SIGNUP_TRIAL_DAYS = 14

export type SignupIntent = 'trial' | 'paid'

export type SignupInput = {
  companyName: string
  slug: string
  industry: TenantIndustry
  currency: string
  timezone: string
  ownerName: string
  ownerEmail: string
  ownerPassword: string
  planId: string
  billingPeriod: 'monthly' | 'annual'
  intent: SignupIntent
}

export type SignupResult = {
  tenantId: string
  slug: string
  /** Always true when this resolves — the workspace exists by then. */
  provisioned: true
  /** Razorpay's hosted authorisation page, for a paid signup. */
  checkoutUrl?: string
  /**
   * Set when the workspace was created but the plan could not be attached. The
   * owner can sign in and choose a plan in the billing portal; nothing has been
   * charged.
   */
  planError?: string
  intent: SignupIntent
}

/**
 * Attach a trial subscription with no gateway object behind it.
 *
 * Shaped exactly like the local half of subscribeTenantToPlan() — same table,
 * same `trialing` status, same one-live rule — but with `gateway` and
 * `gateway_subscription_id` left null, which is precisely what 0070 says an
 * admin-assigned plan looks like. A trial is not a mandate; there is nothing
 * for Razorpay to hold.
 *
 * Refuses when the tenant already has a live subscription rather than closing
 * it out. Only signup calls this, and a brand-new tenant has none — so if one
 * IS there, something is being retried and creating a second is exactly the
 * outcome this must not produce.
 */
export async function attachTrialSubscription(
  input: { tenantId: string; planId: string; billingPeriod: 'monthly' | 'annual'; now?: Date },
  db: DB = ownerDb,
): Promise<{ subscriptionId: string; trialEndsAt: Date }> {
  const now = input.now ?? new Date()
  const trialEndsAt = new Date(now.getTime() + SIGNUP_TRIAL_DAYS * 24 * 60 * 60 * 1000)

  return db.transaction(async (tx) => {
    const [live] = await tx
      .select({ id: tenantSubscriptions.id })
      .from(tenantSubscriptions)
      .where(
        and(
          eq(tenantSubscriptions.tenantId, input.tenantId),
          inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
        ),
      )
      .for('update')
      .limit(1)

    if (live) {
      throw new SignupError('This workspace already has a plan.', null)
    }

    const [row] = await tx
      .insert(tenantSubscriptions)
      .values({
        tenantId: input.tenantId,
        planId: input.planId,
        billingPeriod: input.billingPeriod,
        // The live-but-unpaid state 0070 already defines. Deliberately NOT a
        // sixth enum value: a trial IS a subscription that has not been paid
        // for, which is what `trialing` means everywhere else in this codebase.
        status: 'trialing',
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
      })
      .returning({ id: tenantSubscriptions.id })

    return { subscriptionId: row.id, trialEndsAt }
  })
}

/** True when the tenant already has a live subscription row. */
export async function hasLiveSubscription(tenantId: string, db: DB = ownerDb): Promise<boolean> {
  const [row] = await db
    .select({ id: tenantSubscriptions.id })
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Provision a workspace and put it on a plan. The whole of signup.
 *
 * Takes values the ACTION has already parsed with Zod; this function re-checks
 * the things the database and the catalogue are authoritative about (slug
 * shape, plan existence and activity) because it is also reachable from a test
 * and from any future entry point, and neither should be able to skip them.
 */
export async function selfServeSignup(input: SignupInput): Promise<SignupResult> {
  // ── 1. slug shape, before anything is written ─────────────────────────────
  const problem = slugProblem(input.slug)
  if (problem) throw new SignupError(slugProblemMessage(problem), 'slug')

  // ── 2. the plan, from the DATABASE, and only if it is active ──────────────
  // getPublicPlan() reads through `plans_select_active`, so a retired plan is
  // simply not found. Nothing the browser sent about price is looked at.
  const plan = await getPublicPlan(input.planId)
  if (!plan) {
    throw new SignupError('That plan is not available. Please choose another.', 'planId')
  }

  if (input.intent === 'paid') {
    const price = Number(input.billingPeriod === 'monthly' ? plan.monthlyPrice : plan.annualPrice)
    if (!Number.isFinite(price) || price <= 0) {
      // A zero-priced plan has nothing for a gateway to collect. Offer it as a
      // trial instead of failing at Razorpay with a confusing message.
      throw new SignupError(
        `The ${plan.name} plan has no ${input.billingPeriod} price. Start a free trial instead.`,
        'planId',
      )
    }
  }

  // ── 3. provision — the SHARED transaction, not a copy ─────────────────────
  let provisioned
  try {
    provisioned = await provisionTenant({
      companyName: input.companyName,
      slug: input.slug,
      industry: input.industry,
      currency: input.currency,
      timezone: input.timezone,
      ownerEmail: input.ownerEmail,
      ownerName: input.ownerName,
      ownerPassword: input.ownerPassword,
      // Nobody has paid yet, in either flow. The webhook promotes the account.
      status: 'trial',
    })
  } catch (e) {
    const { code, constraint } = pgError(e)
    if (code === '23505') {
      // THE authority on slug uniqueness, reached when two signups race or a
      // submission is repeated. Told as a field error, not a 500.
      if (!constraint || constraint.includes('slug') || constraint.includes('tenants')) {
        throw new SignupError('That workspace address is no longer available.', 'slug')
      }
      throw new SignupError('Some of these details are already in use.', null)
    }
    throw e
  }

  // ── 4. attach the plan ────────────────────────────────────────────────────
  // Past this point the workspace EXISTS. A failure here is reported as a
  // planError rather than thrown, so the caller can still send the owner to
  // sign in — see the module header for why this is not rolled back.
  if (input.intent === 'trial') {
    try {
      await attachTrialSubscription({
        tenantId: provisioned.tenantId,
        planId: plan.id,
        billingPeriod: input.billingPeriod,
      })
    } catch (e) {
      return {
        tenantId: provisioned.tenantId,
        slug: provisioned.slug,
        provisioned: true,
        intent: input.intent,
        planError: planErrorMessage(e),
      }
    }

    return {
      tenantId: provisioned.tenantId,
      slug: provisioned.slug,
      provisioned: true,
      intent: input.intent,
    }
  }

  // Paid: the EXISTING Razorpay Subscriptions path. It loads the plan again
  // itself, resolves the platform credentials (never a tenant's own Razorpay),
  // proves the gateway price matches the catalogue, and records the local row.
  try {
    const sub = await subscribeTenantToPlan({
      tenantId: provisioned.tenantId,
      planId: plan.id,
      billingPeriod: input.billingPeriod,
    })

    return {
      tenantId: provisioned.tenantId,
      slug: provisioned.slug,
      provisioned: true,
      intent: input.intent,
      checkoutUrl: sub.checkoutUrl ?? undefined,
    }
  } catch (e) {
    return {
      tenantId: provisioned.tenantId,
      slug: provisioned.slug,
      provisioned: true,
      intent: input.intent,
      planError: planErrorMessage(e),
    }
  }
}

/** Safe text for a plan-attachment failure. Never a gateway internal. */
function planErrorMessage(e: unknown): string {
  if (e instanceof SubscriptionError || e instanceof SignupError) return e.message
  console.error('[signup] plan attachment failed:', e)
  return 'Your workspace is ready, but we could not set up billing. Sign in and choose a plan to finish.'
}
