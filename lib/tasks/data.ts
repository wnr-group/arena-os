import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { tasks, memberships } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** All tenant tasks, with the assignee's name — the manager's board. */
export function listTasks(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: tasks.id,
        branchId: tasks.branchId,
        title: tasks.title,
        description: tasks.description,
        assignedTo: tasks.assignedTo,
        assigneeName: memberships.fullName,
        status: tasks.status,
        dueDate: tasks.dueDate,
        createdBy: tasks.createdBy,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .leftJoin(memberships, eq(memberships.id, tasks.assignedTo))
      .where(eq(tasks.tenantId, ctx.tenant.id))
      .orderBy(asc(tasks.dueDate), asc(tasks.createdAt)),
  )
}

/** The signed-in member's own assigned tasks. */
export function listMyTasks(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, ctx.tenant.id), eq(tasks.assignedTo, ctx.membershipId)))
      .orderBy(asc(tasks.dueDate), asc(tasks.createdAt)),
  )
}
