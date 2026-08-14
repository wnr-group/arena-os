'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Circle, Clock, ListTodo, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { createTask, updateTask, updateTaskStatus, deleteTask } from '@/lib/actions/tasks'

type TaskStatus = 'open' | 'in_progress' | 'done'
type TaskRow = {
  id: string
  title: string
  description: string | null
  assignedTo: string | null
  assigneeName: string | null
  status: TaskStatus
  dueDate: string | null
}
type Member = { id: string; name: string }
type Modal = { mode: 'add' } | { mode: 'edit'; row: TaskRow }

const STATUS_LABELS: Record<TaskStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done' }
const STATUS_BADGE: Record<TaskStatus, string> = {
  open: 'bg-amber-500/10 text-amber-600',
  in_progress: 'bg-blue-500/10 text-blue-600',
  done: 'bg-emerald-500/10 text-emerald-600',
}
const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

export function TasksView({
  isManagerView,
  currentMembershipId,
  members,
  tasks,
}: {
  isManagerView: boolean
  currentMembershipId: string
  members: Member[]
  tasks: TaskRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all')

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const stats = useMemo(() => {
    const total = tasks.length
    const open = tasks.filter((t) => t.status === 'open').length
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length
    const done = tasks.filter((t) => t.status === 'done').length
    return { total, open, inProgress, done }
  }, [tasks])

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false
      if (q && !t.title.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [tasks, search, statusFilter])

  function handleStatusChange(task: TaskRow, status: TaskStatus) {
    setError(null)
    setStatusUpdatingId(task.id)
    start(async () => {
      const r = await updateTaskStatus(task.id, status)
      setStatusUpdatingId(null)
      if (r.error) setError(r.error)
      else router.refresh()
    })
  }

  function handleDelete(task: TaskRow) {
    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) return
    setError(null)
    setDeletingId(task.id)
    start(async () => {
      const r = await deleteTask(task.id)
      setDeletingId(null)
      if (r.error) setError(r.error)
      else router.refresh()
    })
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={ListTodo} label="Total tasks" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={Circle} label="Open" value={stats.open} accent="bg-amber-500/10 text-amber-600" />
        <StatCard icon={Clock} label="In progress" value={stats.inProgress} accent="bg-blue-500/10 text-blue-600" />
        <StatCard icon={CheckCircle2} label="Done" value={stats.done} accent="bg-emerald-500/10 text-emerald-600" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <input
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-3 pr-3 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isManagerView && (
          <button
            onClick={() => setModal({ mode: 'add' })}
            className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          >
            <Plus size={16} /> Add task
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(['all', 'open', 'in_progress', 'done'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
              statusFilter === s
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            }`}
          >
            {s === 'all' ? 'All' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Task</th>
                {isManagerView && <th className="px-4 py-3 font-medium">Assignee</th>}
                <th className="px-4 py-3 font-medium">Due date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {isManagerView && <th className="px-4 py-3 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredTasks.length === 0 && (
                <tr>
                  <td colSpan={isManagerView ? 5 : 3} className="px-4 py-10 text-center text-base text-muted-foreground">
                    {tasks.length === 0 ? 'No tasks yet.' : 'No tasks match your filters.'}
                  </td>
                </tr>
              )}
              {filteredTasks.map((t) => {
                const overdue = !!t.dueDate && t.dueDate < today && t.status !== 'done'
                const canUpdateStatus = isManagerView || t.assignedTo === currentMembershipId
                return (
                  <tr key={t.id} className="transition hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <p className="font-medium">{t.title}</p>
                      {t.description && <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{t.description}</p>}
                    </td>
                    {isManagerView && (
                      <td className="px-4 py-3 text-muted-foreground">{t.assigneeName || 'Unassigned'}</td>
                    )}
                    <td className={`px-4 py-3 ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
                      {t.dueDate ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {canUpdateStatus ? (
                        <div className="relative inline-flex items-center">
                          <select
                            className={`appearance-none rounded-full border-0 py-1 pl-2.5 pr-7 text-sm font-medium outline-none ${STATUS_BADGE[t.status]}`}
                            value={t.status}
                            disabled={statusUpdatingId === t.id}
                            onChange={(e) => handleStatusChange(t, e.target.value as TaskStatus)}
                          >
                            <option value="open">Open</option>
                            <option value="in_progress">In progress</option>
                            <option value="done">Done</option>
                          </select>
                          {statusUpdatingId === t.id && (
                            <Loader2 size={13} className="pointer-events-none absolute right-2 animate-spin" />
                          )}
                        </div>
                      ) : (
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${STATUS_BADGE[t.status]}`}>
                          {STATUS_LABELS[t.status]}
                        </span>
                      )}
                    </td>
                    {isManagerView && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button className={btn} onClick={() => setModal({ mode: 'edit', row: t })} aria-label="Edit">
                            <Pencil size={16} />
                          </button>
                          <button
                            className={`${btn} text-destructive`}
                            disabled={pending}
                            onClick={() => handleDelete(t)}
                            aria-label="Delete"
                          >
                            {deletingId === t.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <TaskModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          members={members}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: ComponentType<{ size?: number }>
  label: string
  value: string | number
  accent: string
}) {
  return (
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function TaskModal({
  row,
  members,
  onClose,
  onSaved,
}: {
  row?: TaskRow
  members: Member[]
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(row?.title ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [assignedTo, setAssignedTo] = useState(row?.assignedTo ?? '')
  const [dueDate, setDueDate] = useState(row?.dueDate ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [pending, start] = useTransition()

  const errors = useMemo(() => {
    const e: { title?: string } = {}
    if (!title.trim()) e.title = 'Title is required.'
    return e
  }, [title])
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    setError(null)
    start(async () => {
      const r = row
        ? await updateTask({ id: row.id, title: title.trim(), description, assignedTo, dueDate })
        : await createTask({ title: title.trim(), description, assignedTo, dueDate })
      if (r.error) setError(r.error)
      else onSaved()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit task' : 'Add task'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div>
            <label className={label}>Title</label>
            <input
              className={input}
              placeholder="e.g. Restock napkins"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            {submitted && errors.title && <p className={errorText}>{errors.title}</p>}
          </div>
          <div>
            <label className={label}>Description (optional)</label>
            <textarea className={input} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Assignee</label>
              <select className={input} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Due date</label>
              <input className={input} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save changes' : 'Add task'}
          </button>
          <button className={`${btn} border`} disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
