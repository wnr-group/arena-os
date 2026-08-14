'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ownerDb } from '@/db'
import { tenants, branches, memberships } from '@/db/schema'
import { requirePlatformAdmin, PlatformError } from '@/lib/platform/guard'
import { findOrCreateUser } from '@/lib/platform/provision'
import { RESERVED_SLUGS } from '@/lib/tenant/subdomain'
import { zodErrorMessage } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof PlatformError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const msg = e instanceof Error ? e.message : 'Something went wrong.'
  if (/unique|duplicate/i.test(msg)) return { error: 'That subdomain or email is already in use.' }
  return { error: msg }
}

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'Use 3–50 chars: lowercase letters, numbers, hyphens')
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
    'other',
  ]),
  currency: z.string().trim().default('INR'),
  timezone: z.string().trim().default('Asia/Kolkata'),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(1, 'Owner name is required'),
  ownerPassword: z.string().min(8, 'Password must be at least 8 characters'),
})

export async function createCompany(input: z.input<typeof createInput>): Promise<Result & { slug?: string }> {
  try {
    await requirePlatformAdmin()
    const v = createInput.parse(input)

    const [taken] = await ownerDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, v.slug)).limit(1)
    if (taken) return { error: 'That subdomain is already taken.' }

    const { userId } = await findOrCreateUser({
      email: v.ownerEmail,
      fullName: v.ownerName,
      password: v.ownerPassword,
    })

    await ownerDb.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          slug: v.slug,
          name: v.companyName,
          industry: v.industry,
          status: 'active',
          currency: v.currency,
          timezone: v.timezone,
        })
        .returning({ id: tenants.id })

      const [branch] = await tx
        .insert(branches)
        .values({ tenantId: tenant.id, name: 'Main Branch', isPrimary: true })
        .returning({ id: branches.id })

      await tx.insert(memberships).values({
        tenantId: tenant.id,
        userId,
        branchId: branch.id,
        role: 'owner',
        status: 'active',
        fullName: v.ownerName,
        email: v.ownerEmail.toLowerCase(),
      })
    })

    revalidatePath('/admin')
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
