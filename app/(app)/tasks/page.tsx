import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listTasks, listMyTasks } from '@/lib/tasks/data'
import { listActiveMembers } from '@/lib/memberships/data'
import { TasksView } from '@/components/tasks/TasksView'

export default async function TasksPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  const manager = isManager(ctx.role)

  const members = manager ? await listActiveMembers(ctx) : []
  const tasks = manager
    ? (await listTasks(ctx)).map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        assignedTo: t.assignedTo,
        assigneeName: t.assigneeName,
        status: t.status,
        dueDate: t.dueDate,
      }))
    : (await listMyTasks(ctx)).map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        assignedTo: ctx.membershipId,
        assigneeName: null,
        status: t.status,
        dueDate: t.dueDate,
      }))

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {manager ? 'Assign work and track status across the team — tenant scoped.' : 'Your assigned tasks.'}
      </p>
      <TasksView
        isManagerView={manager}
        currentMembershipId={ctx.membershipId}
        members={members.map((m) => ({ id: m.id, name: m.fullName || m.email || 'Unnamed' }))}
        tasks={tasks}
      />
    </div>
  )
}
