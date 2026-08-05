'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { tasks } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { isManager } from '@/lib/auth/roles'

type Result = { error?: string; id?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const taskInput = z.object({
  branchId: z.string().uuid().optional(),
  title: z.string().trim().min(1, 'Title is required'),
  description: z.string().trim().optional(),
  assignedTo: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export async function createTask(input: z.input<typeof taskInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = taskInput.parse(input)

    const [task] = await withUser(ctx.user.id, (tx) =>
      tx
        .insert(tasks)
        .values({
          tenantId: ctx.tenant.id,
          branchId: v.branchId || null,
          title: v.title,
          description: v.description || null,
          assignedTo: v.assignedTo || null,
          dueDate: v.dueDate || null,
          createdBy: ctx.membershipId,
        })
        .returning({ id: tasks.id }),
    )

    return { id: task.id }
  } catch (e) {
    return fail(e)
  }
}

const updateInput = taskInput.partial().extend({ id: z.string().uuid() })

/** Manager edit: retitle, reassign, reschedule. */
export async function updateTask(input: z.input<typeof updateInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = updateInput.parse(input)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(tasks)
        .set({
          ...(v.title !== undefined && { title: v.title }),
          ...(v.description !== undefined && { description: v.description || null }),
          ...(v.branchId !== undefined && { branchId: v.branchId || null }),
          ...(v.assignedTo !== undefined && { assignedTo: v.assignedTo || null }),
          ...(v.dueDate !== undefined && { dueDate: v.dueDate || null }),
        })
        .where(and(eq(tasks.id, v.id), eq(tasks.tenantId, ctx.tenant.id))),
    )

    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Status moves: the assignee tracking their own work, or a manager overseeing the board. */
export async function updateTaskStatus(id: string, status: 'open' | 'in_progress' | 'done'): Promise<Result> {
  try {
    const ctx = await requireContext()

    await withUser(ctx.user.id, async (tx) => {
      const [task] = await tx
        .select({ assignedTo: tasks.assignedTo })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!task) throw new Error('Task not found.')
      if (task.assignedTo !== ctx.membershipId && !isManager(ctx.role)) {
        throw new AuthError('Only the assignee or a manager can update this task.')
      }
      await tx.update(tasks).set({ status }).where(eq(tasks.id, id))
    })

    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteTask(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => tx.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, ctx.tenant.id))))
    return {}
  } catch (e) {
    return fail(e)
  }
}
