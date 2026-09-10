import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  businessProfiles,
  memberships,
  membershipPlans,
  menuItems,
  paymentSettings,
  resources,
  taxRates,
  workingHours,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager, isOwner } from '@/lib/auth/roles'

/**
 * The new-workspace onboarding checklist (M16 #6).
 *
 * ── It is DERIVED, not stored ───────────────────────────────────────────────
 *
 * There is no `onboarding_steps` table and no per-tenant progress column. Every
 * item below is a count against the table the step is actually about, so the
 * checklist cannot drift from reality: adding a resource ticks "Add resources"
 * because there is now a resource, not because something remembered to write a
 * flag. Deleting the last one un-ticks it, which is correct — the workspace
 * genuinely is not set up any more.
 *
 * That also means no migration, nothing to backfill for the tenants that
 * already exist, and nothing to keep in sync when a step is added or removed.
 * A stored checklist would have needed all three, and would have been able to
 * claim a venue had configured working hours when it had not.
 *
 * The trade is one small query per dashboard render. Every item is a bounded
 * `exists`/`count` on a tenant-scoped, indexed table, all in ONE round trip.
 *
 * ── Every step points at a real, already-built page ─────────────────────────
 *
 * Nothing here was invented for the checklist. Each `href` is a settings screen
 * that exists in this app today, and each `done` test reads the table that
 * screen writes.
 *
 * ── It never blocks ─────────────────────────────────────────────────────────
 *
 * The checklist is a panel on the dashboard. No route is gated on it, no action
 * refuses because a step is incomplete, and it disappears on its own once
 * everything is done. A brand-new owner can ignore it entirely and use the app.
 */

export type OnboardingStep = {
  key: string
  title: string
  description: string
  href: string
  done: boolean
  /** Steps a cashier could not action are hidden rather than shown as blocked. */
  ownerOnly?: boolean
}

export type OnboardingProgress = {
  steps: OnboardingStep[]
  completed: number
  total: number
  /** True once every visible step is done — the panel stops rendering. */
  allDone: boolean
}

/**
 * Read the tenant's setup state and turn it into the checklist.
 *
 * withUser() on the restricted connection, so every count is RLS-scoped to the
 * caller's own tenant exactly like the pages these steps link to. The tenant id
 * predicate is stated as well, so each count is correct on its own terms.
 */
export async function getOnboardingProgress(ctx: ActiveContext): Promise<OnboardingProgress> {
  const tenantId = ctx.tenant.id

  // One round trip, eight scalar sub-selects. Each is a bounded count on a
  // tenant-scoped, indexed table, and each is additionally reduced by that
  // table's own RLS policy under withUser().
  //
  // `::int` matters: count() is bigint, which node-postgres hands back as a
  // STRING to avoid precision loss. A string is truthy, so `> 0` would be true
  // even for '0' and every step would show as done.
  const { rows } = await withUser(ctx.user.id, (tx) =>
    tx.execute<{
      resources: number
      hours: number
      profile: number
      tax_rates: number
      menu_items: number
      payments: number
      plans: number
      team: number
    }>(sql`
      select
        (select count(*) from ${resources}        where tenant_id = ${tenantId}::uuid)::int as resources,
        (select count(*) from ${workingHours}     where tenant_id = ${tenantId}::uuid)::int as hours,
        (select count(*) from ${businessProfiles} where tenant_id = ${tenantId}::uuid)::int as profile,
        (select count(*) from ${taxRates}         where tenant_id = ${tenantId}::uuid)::int as tax_rates,
        (select count(*) from ${menuItems}        where tenant_id = ${tenantId}::uuid)::int as menu_items,
        (select count(*) from ${paymentSettings}
          where tenant_id = ${tenantId}::uuid and razorpay_key_id is not null)::int as payments,
        (select count(*) from ${membershipPlans}  where tenant_id = ${tenantId}::uuid)::int as plans,
        -- The owner provisioning created is member #1; anything beyond that is
        -- a team the owner has actually invited.
        (select count(*) from ${memberships}
          where tenant_id = ${tenantId}::uuid and role <> 'owner')::int as team
    `),
  )

  const r = rows[0]
  const counts = {
    resources: Number(r?.resources ?? 0),
    hours: Number(r?.hours ?? 0),
    profile: Number(r?.profile ?? 0),
    taxRates: Number(r?.tax_rates ?? 0),
    menuItems: Number(r?.menu_items ?? 0),
    payments: Number(r?.payments ?? 0),
    plans: Number(r?.plans ?? 0),
    team: Number(r?.team ?? 0),
  }

  const all: OnboardingStep[] = [
    {
      key: 'resources',
      title: 'Add your resources',
      description: 'The bays, rooms, tables or studios customers book. Nothing can be booked until one exists.',
      href: '/settings/resources/types',
      done: counts.resources > 0,
    },
    {
      key: 'hours',
      title: 'Set your working hours',
      description: 'When you are open. Availability and the public booking site are both built from this.',
      href: '/settings/hours',
      done: counts.hours > 0,
    },
    {
      key: 'business-profile',
      title: 'Complete your business profile',
      description: 'Legal name, address and GSTIN — printed on every invoice you raise.',
      href: '/settings/business',
      done: counts.profile > 0,
      ownerOnly: true,
    },
    {
      key: 'tax-rates',
      title: 'Configure tax rates',
      description: 'The GST rates your bookings and menu items are charged at.',
      href: '/settings/tax-rates',
      done: counts.taxRates > 0,
    },
    {
      key: 'menu',
      title: 'Build your menu',
      description: 'Food and drink items the till and kitchen work from. Skip this if you do not serve food.',
      href: '/menu/items',
      done: counts.menuItems > 0,
    },
    {
      key: 'payments',
      title: 'Connect online payments',
      description: 'Your own Razorpay keys, so customers can pay deposits online.',
      href: '/settings/payments',
      done: counts.payments > 0,
    },
    {
      key: 'memberships',
      title: 'Set up memberships',
      description: 'Plans customers can buy for discounts, free hours and wallet credit.',
      href: '/settings/memberships',
      done: counts.plans > 0,
    },
    {
      key: 'team',
      title: 'Invite your team',
      description: 'Add the managers and cashiers who will run the front desk.',
      href: '/settings/team',
      done: counts.team > 0,
    },
  ]

  // A cashier sees only what a cashier can actually do something about. The
  // pages themselves enforce their own roles regardless — this just avoids
  // showing somebody a task they would be redirected away from.
  const steps = all.filter((s) => {
    if (s.ownerOnly) return isOwner(ctx.role)
    return isManager(ctx.role)
  })

  const completed = steps.filter((s) => s.done).length
  return { steps, completed, total: steps.length, allDone: steps.length > 0 && completed === steps.length }
}

