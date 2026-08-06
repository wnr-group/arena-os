'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, X, ListTree, CheckCircle2, XCircle } from 'lucide-react'
import { upsertMenuCategory, deleteMenuCategory } from '@/lib/actions/menu'

type CategoryRow = { id: string; name: string; sortOrder: number; isActive: boolean }
type Modal = { mode: 'add' } | { mode: 'edit'; row: CategoryRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function MenuCategoriesManager({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)

  const run: Run = (fn, onSuccess) => {
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      else {
        router.refresh()
        onSuccess?.()
      }
    })
  }

  const stats = useMemo(() => {
    const total = categories.length
    const active = categories.filter((c) => c.isActive).length
    return { total, active, inactive: total - active }
  }, [categories])

  function handleDelete(row: CategoryRow) {
    if (!window.confirm(`Delete category "${row.name}"? This cannot be undone.`)) return
    run(() => deleteMenuCategory(row.id))
  }

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={ListTree} label="Total categories" value={stats.total} accent="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle2} label="Active" value={stats.active} accent="bg-emerald-500/10 text-emerald-600" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} accent="bg-muted text-muted-foreground" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All categories</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add category
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Sort order</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {categories.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No categories yet. Add one to get started.
                  </td>
                </tr>
              )}
              {categories.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.sortOrder}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {row.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button className={btn} onClick={() => setModal({ mode: 'edit', row })} aria-label="Edit">
                        <Pencil size={15} />
                      </button>
                      <button
                        className={`${btn} text-destructive`}
                        disabled={pending}
                        onClick={() => handleDelete(row)}
                        aria-label="Delete"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <CategoryModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
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
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function CategoryModal({
  row,
  pending,
  run,
  onClose,
}: {
  row?: CategoryRow
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(row?.name ?? '')
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0))
  const [isActive, setIsActive] = useState(row?.isActive ?? true)

  function submit() {
    run(
      () =>
        upsertMenuCategory({
          id: row?.id,
          name,
          sortOrder: sortOrder === '' ? 0 : Number(sortOrder),
          isActive,
        }),
      onClose,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{row ? 'Edit category' : 'Add category'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              className={input}
              placeholder="e.g. Starters"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Sort order</label>
            <input
              className={input}
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button className={`${btn} flex-1 bg-primary text-primary-foreground`} disabled={pending || !name} onClick={submit}>
            {row ? 'Save changes' : 'Add category'}
          </button>
          <button className={`${btn} border`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
