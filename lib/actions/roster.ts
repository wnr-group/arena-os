'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { rosters, shifts } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { addDays } from '@/lib/booking/data'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string; id?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23505') return { error: 'A roster already exists for that branch and week.' }
  console.error('[roster] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const timeStr = z.string().regex(/^\d{2}:\d{2}$/)

const rosterInput = z.object({
  branchId: z.string().uuid(),
  weekStart: dateStr,
  note: z.string().trim().optional(),
})

/** Get-or-create the roster for a branch+week — the entry point for the weekly builder. */
export async function upsertRoster(input: z.input<typeof rosterInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = rosterInput.parse(input)

    const [roster] = await withUser(ctx.user.id, (tx) =>
      tx
        .insert(rosters)
        .values({ tenantId: ctx.tenant.id, branchId: v.branchId, weekStart: v.weekStart, note: v.note || null })
        .onConflictDoUpdate({
          target: [rosters.branchId, rosters.weekStart],
          set: { note: v.note || null },
        })
        .returning({ id: rosters.id }),
    )

    return { id: roster.id }
  } catch (e) {
    return fail(e)
  }
}

const shiftInput = z.object({
  id: z.string().uuid().optional(),
  rosterId: z.string().uuid(),
  membershipId: z.string().uuid(),
  shiftDate: dateStr,
  type: z.enum(['morning', 'evening', 'night']),
  starts: timeStr,
  ends: timeStr,
})

/** Assign (or edit) one staff member's shift within a roster week. */
export async function saveShift(input: z.input<typeof shiftInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = shiftInput.parse(input)

    if (v.ends <= v.starts) return { error: 'Shift end time must be after the start time.' }

    const result = await withUser(ctx.user.id, async (tx) => {
      const [roster] = await tx
        .select({ id: rosters.id, branchId: rosters.branchId, weekStart: rosters.weekStart })
        .from(rosters)
        .where(and(eq(rosters.id, v.rosterId), eq(rosters.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!roster) return { error: 'Roster not found.' }

      const weekEnd = addDays(roster.weekStart, 6)
      if (v.shiftDate < roster.weekStart || v.shiftDate > weekEnd) {
        return { error: 'Shift date falls outside that roster’s week.' }
      }

      const values = {
        tenantId: ctx.tenant.id,
        branchId: roster.branchId,
        membershipId: v.membershipId,
        rosterId: roster.id,
        shiftDate: v.shiftDate,
        type: v.type,
        starts: v.starts,
        ends: v.ends,
      }

      if (v.id) {
        const [row] = await tx
          .update(shifts)
          .set(values)
          .where(and(eq(shifts.id, v.id), eq(shifts.tenantId, ctx.tenant.id)))
          .returning({ id: shifts.id })
        return { id: row?.id }
      }
      const [row] = await tx.insert(shifts).values(values).returning({ id: shifts.id })
      return { id: row.id }
    })

    return result
  } catch (e) {
    return fail(e)
  }
}

export async function deleteShift(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => tx.delete(shifts).where(and(eq(shifts.id, id), eq(shifts.tenantId, ctx.tenant.id))))
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteRoster(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => tx.delete(rosters).where(and(eq(rosters.id, id), eq(rosters.tenantId, ctx.tenant.id))))
    return {}
  } catch (e) {
    return fail(e)
  }
}
