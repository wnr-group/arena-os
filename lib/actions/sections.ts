'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { BookingError } from '@/lib/booking/service'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import {
  clearAssignmentsCore,
  createSectionCore,
  deleteSectionCore,
  handOffServerCore,
  renameSectionCore,
  setSectionServerCore,
  setSessionServerCore,
  setTableSectionCore,
  setTableServerCore,
} from '@/lib/sections/service'
import { zodErrorMessage } from '@/lib/utils/errors'

const MODULE = 'module.floor_sections'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof BookingError || e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  if ((e as { cause?: { code?: string } })?.cause?.code === '23505') return { error: 'A section with that name already exists.' }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

type Ctx = Awaited<ReturnType<typeof requireManager>>

/** Shape the floor + assign servers: owner/manager, restaurant, plan-gated. */
async function requireFloorManager(): Promise<Ctx> {
  const ctx = await requireManager()
  if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Floor sections are for restaurant venues.')
  await requireEntitlement(ctx, MODULE)
  return ctx
}

async function run<T>(fn: (ctx: Ctx, actor: { tenantId: string; membershipId: string }) => Promise<T>): Promise<Result & { data?: T }> {
  try {
    const ctx = await requireFloorManager()
    const data = await fn(ctx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId })
    revalidatePath('/settings/sections')
    revalidatePath('/floor')
    return { data }
  } catch (e) {
    return fail(e)
  }
}

const id = z.string().uuid()
const idOrNull = z.string().uuid().nullable()

export async function createSection(branchId: string, name: string) {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => createSectionCore(tx, a, { branchId: id.parse(branchId), name })))
}

export async function renameSection(sectionId: string, name: string) {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => renameSectionCore(tx, a, id.parse(sectionId), name)))
}

export async function deleteSection(sectionId: string) {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => deleteSectionCore(tx, a, id.parse(sectionId))))
}

export async function setTableSection(resourceId: string, sectionId: string | null) {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => setTableSectionCore(tx, a, id.parse(resourceId), idOrNull.parse(sectionId))))
}

/** `handOff` also moves the section's running sessions to the new server. */
export async function setSectionServer(sectionId: string, serverId: string | null, handOff = false) {
  return run((ctx, a) =>
    withUser(ctx.user.id, (tx) => setSectionServerCore(tx, a, id.parse(sectionId), idOrNull.parse(serverId), { handOffOpenSessions: handOff })),
  )
}

export async function setTableServer(resourceId: string, serverId: string | null, handOff = false) {
  return run((ctx, a) =>
    withUser(ctx.user.id, (tx) => setTableServerCore(tx, a, id.parse(resourceId), idOrNull.parse(serverId), { handOffOpenSessions: handOff })),
  )
}

/** A server goes home: hand all of their sections, tables and running sessions to someone else. */
export async function handOffServer(fromServerId: string, toServerId: string | null) {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => handOffServerCore(tx, a, id.parse(fromServerId), idOrNull.parse(toServerId))))
}

/** End of shift: clear every section/table assignment. */
export async function clearAssignments() {
  return run((ctx, a) => withUser(ctx.user.id, (tx) => clearAssignmentsCore(tx, a)))
}

/**
 * Reassign a single running session from the floor — any front-of-house role
 * (the same set that seats walk-ins), since a host often covers for a server.
 */
export async function setSessionServer(bookingId: string, serverId: string | null): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Floor sections are for restaurant venues.')
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to change a table’s server.')
    await requireEntitlement(ctx, MODULE)
    await withUser(ctx.user.id, (tx) =>
      setSessionServerCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, id.parse(bookingId), idOrNull.parse(serverId)),
    )
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}
