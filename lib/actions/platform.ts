'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ownerDb } from '@/db'
import { tenants, branches, memberships, plans } from '@/db/schema'
import { requirePlatformAdmin, PlatformError } from '@/lib/platform/guard'
import { findOrCreateUser, provisionTenant } from '@/lib/platform/provision'
// The one path that puts a tenant on a plan, reused rather than re-implemented
// — see createCompany() for why an admin-created company must not be born
// without one.
import { assignPlan } from './plans'
import { SLUG_PATTERN, SLUG_RULES } from '@/lib/platform/slug'
import { RESERVED_SLUGS } from '@/lib/tenant/subdomain'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof PlatformError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23505') return { error: 'That subdomain or email is already in use.' }
  console.error('[platform] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

// The shape rule now lives in lib/platform/slug.ts, shared with self-serve
// signup (M16 #6) so the two entry points cannot drift. Same regex, same
// reserved set, same wording — this is a re-export in Zod form, not a variant.
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, SLUG_RULES)
  .refine((s) => !RESERVED_SLUGS.has(s), 'That subdomain is reserved')

const createInput = z.object({
  companyName: z.string().trim().min(1, 'Company name is required'),
  slug: slugSchema,
  industry: z.enum([
    'gaming_cafe',
    'recording_studio',
    'podcast_studio',
    'dance_studio',
    'vr_centre',
    'restaurant',
    'other',
  ]),
  currency: z.string().trim().default('INR'),
  timezone: z.string().trim().default('Asia/Kolkata'),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(1, 'Owner name is required'),
  ownerPassword: z.string().min(8, 'Password must be at least 8 characters'),
  /**
   * REQUIRED, and required for a reason — see createCompany() below. A company
   * created without one is a company with payroll, expenses and every report
   * switched off.
   */
  planId: z.string().uuid('Choose a plan for this company'),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
})

/**
 * Provision a company AND put it on a plan.
 *
 * ── Why the plan is not optional ────────────────────────────────────────────
 *
 * M16 #2's entitlement gates are fail-closed: `readEntitlements()` answers
 * `plan: null, entitlements: {}` for a tenant with no live subscription, and
 * the guard grants a module only on an explicit `true` and a limit only on an
 * explicit number or null. So a company created without a plan opens with
 * payroll, expenses and every report switched off, and its staff and resources
 * capped — a workspace nobody can actually use, with no error to explain it.
 *
 * Self-serve signup never had this problem: lib/signup/service.ts attaches a
 * trial in the same flow. This path is the one that did, which is why 0086
 * grandfathers the tenants that already exist and why this makes `planId`
 * required — the backfill is a one-shot repair, and without this it would start
 * re-accumulating the same broken companies the next day.
 *
 * ── Order: check, provision, assign ─────────────────────────────────────────
 *
 * provisionTenant() deliberately does not create a subscription — a plan is a
 * separate concern with its own failure modes, and folding it in would mean
 * that concern could stop a workspace from existing. The caller is supposed to
 * attach one afterwards, and this is that caller.
 *
 * Two transactions therefore, not one, so the plan is VALIDATED first: an
 * unknown or retired plan is refused before anything is written, which turns
 * the common mistake into a clean refusal rather than a half-made company. What
 * remains is the narrow case where provisioning succeeds and the assignment
 * then fails on a genuine database error. That is reported rather than swallowed
 * — the company exists and the operator is told exactly what is missing and
 * where to fix it — because deleting a just-created tenant to unwind it would be
 * a destructive answer to a recoverable problem.
 */
export async function createCompany(
  input: z.input<typeof createInput>,
): Promise<Result & { slug?: string; warning?: string }> {
  try {
    await requirePlatformAdmin()
    const v = createInput.parse(input)

    const [taken] = await ownerDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, v.slug)).limit(1)
    if (taken) return { error: 'That subdomain is already taken.' }

    // Validated BEFORE provisioning, so the usual failure — a plan id that is
    // stale, or one retired since the form was opened — costs nothing. Retired
    // plans are excluded on purpose: `active = false` means "grandfathering
    // only, never sell this again", and the Grandfathered plan 0086 creates is
    // exactly such a row. A new company must never be started on one.
    const [plan] = await ownerDb
      .select({ id: plans.id, name: plans.name, active: plans.active })
      .from(plans)
      .where(eq(plans.id, v.planId))
      .limit(1)

    if (!plan) return { error: 'That plan no longer exists. Reload and pick another.' }
    if (!plan.active) {
      return {
        error: `“${plan.name}” is retired and cannot be sold. Pick a live plan, or reactivate it from Plans first.`,
      }
    }

    // The provisioning transaction itself now lives in lib/platform/provision.ts
    // and is shared with self-serve signup (M16 #6), so an admin-created tenant
    // and a self-registered one get byte-for-byte the same base setup. Behaviour
    // here is unchanged: same four inserts, same order, same 'active' status —
    // which is why `status` is left to its default rather than passed.
    const provisioned = await provisionTenant({
      companyName: v.companyName,
      slug: v.slug,
      industry: v.industry,
      currency: v.currency,
      timezone: v.timezone,
      ownerEmail: v.ownerEmail,
      ownerName: v.ownerName,
      ownerPassword: v.ownerPassword,
    })

    // assignPlan(), not a second insert written here: it is the one path that
    // closes out any live row and opens the new one in a single transaction,
    // and it records the platform-override audit entry that AROS-114 §9 requires
    // of every manual plan change. A brand-new tenant has nothing to close out,
    // but reusing the action is what keeps "how a tenant gets a plan" a single
    // answer rather than two that can drift.
    const assigned = await assignPlan({
      tenantId: provisioned.tenantId,
      planId: v.planId,
      billingPeriod: v.billingPeriod,
    })

    revalidatePath('/admin')

    if (assigned.error) {
      // The company is real and signed-in-able; only the plan is missing. Say
      // so precisely, because the symptom otherwise reaching the operator is
      // the owner reporting that payroll and reports do not work.
      return {
        slug: v.slug,
        warning: `${v.companyName} was created, but assigning “${plan.name}” failed: ${assigned.error} Until a plan is assigned from the company page, payroll, expenses and reports will be unavailable to them.`,
      }
    }

    return { slug: v.slug }
  } catch (e) {
    return fail(e)
  }
}

export async function setCompanyStatus(
  id: string,
  status: 'trial' | 'active' | 'suspended' | 'cancelled',
): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await ownerDb.update(tenants).set({ status }).where(eq(tenants.id, id))
    revalidatePath('/admin')
    revalidatePath(`/admin/companies/${id}`)
    return {}
  } catch (e) {
    return fail(e)
  }
}

const updateInput = z.object({
  name: z.string().trim().min(1),
  industry: z.enum([
    'gaming_cafe',
    'recording_studio',
    'podcast_studio',
    'dance_studio',
    'vr_centre',
    'restaurant',
    'other',
  ]),
  currency: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
})

export async function updateCompany(id: string, input: z.input<typeof updateInput>): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = updateInput.parse(input)
    await ownerDb.update(tenants).set(v).where(eq(tenants.id, id))
    revalidatePath(`/admin/companies/${id}`)
    revalidatePath('/admin')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const memberInput = z.object({
  tenantId: z.string().uuid(),
  email: z.string().trim().email(),
  fullName: z.string().trim().min(1),
  role: z.enum(['owner', 'manager', 'cashier', 'kitchen_staff', 'floor_staff', 'receptionist']),
  password: z.string().min(8).optional(),
})

export async function addCompanyMember(input: z.input<typeof memberInput>): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = memberInput.parse(input)

    const [branch] = await ownerDb
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, v.tenantId), eq(branches.isPrimary, true)))
      .limit(1)

    const { userId } = await findOrCreateUser({
      email: v.email,
      fullName: v.fullName,
      password: v.password,
    })

    await ownerDb
      .insert(memberships)
      .values({
        tenantId: v.tenantId,
        userId,
        branchId: branch?.id ?? null,
        role: v.role,
        status: 'active',
        fullName: v.fullName,
        email: v.email.toLowerCase(),
      })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { role: v.role, status: 'active', fullName: v.fullName, email: v.email.toLowerCase() },
      })

    revalidatePath(`/admin/companies/${v.tenantId}`)
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function removeCompanyMember(membershipId: string, tenantId: string): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await ownerDb.delete(memberships).where(eq(memberships.id, membershipId))
    revalidatePath(`/admin/companies/${tenantId}`)
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteCompany(id: string): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await ownerDb.delete(tenants).where(eq(tenants.id, id))
    revalidatePath('/admin')
    return {}
  } catch (e) {
    return fail(e)
  }
}
