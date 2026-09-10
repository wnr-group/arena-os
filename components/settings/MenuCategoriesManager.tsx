'use client'

import { useMemo, useState, useTransition, type ComponentType } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, ListTree, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { upsertMenuCategory, deleteMenuCategory } from '@/lib/actions/menu'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { STAT_TINT_CLASSES, type StatTint } from '@/lib/ui/statTint'

type CategoryRow = { id: string; name: string; sortOrder: number; isActive: boolean }
type Modal = { mode: 'add' } | { mode: 'edit'; row: CategoryRow }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'
const btn =
  'rounded-lg px-3.5 py-2.5 text-base font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-50'
const NAME_PATTERN = /^[\p{L}\p{N} &'.,()-]+$/u

export function MenuCategoriesManager({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [modal, setModal] = useState<Modal | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const run: Run = (fn, onSuccess) => {
    start(async () => {
      const r = await fn()
      if (r.error) {
        toast.error(r.error)
      } else {
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

  async function handleDelete(row: CategoryRow) {
    await confirm({
      title: `Delete category "${row.name}"?`,
      description: 'This cannot be undone.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteMenuCategory(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          router.refresh()
          toast.success(`Category "${row.name}" deleted.`)
        }
      },
    })
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={ListTree} label="Total categories" value={stats.total} tint="rose" />
        <StatCard icon={CheckCircle2} label="Active" value={stats.active} tint="mint" />
        <StatCard icon={XCircle} label="Inactive" value={stats.inactive} tint="slate" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
          All categories {categories.length > 0 && <span className="text-muted-foreground/60">({categories.length})</span>}
        </h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={16} /> Add Category
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
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
                  <td colSpan={4} className="px-4 py-10 text-center text-base text-muted-foreground">
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
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${
                        row.isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {row.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button className={btn} disabled={pending} onClick={() => setModal({ mode: 'edit', row })} aria-label="Edit">
                        <Pencil size={16} />
                      </button>
                      <button
                        className={`${btn} text-destructive`}
                        disabled={pending}
                        onClick={() => handleDelete(row)}
                        aria-label="Delete"
                      >
                        {deletingId === row.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
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
  tint,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  value: string | number
  tint: StatTint
}) {
  const { card, icon } = STAT_TINT_CLASSES[tint]
  return (
    <div className={`group rounded-xl border p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md sm:p-5 ${card}`}>
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-white transition-transform duration-300 group-hover:scale-110">
        <Icon size={18} className={icon} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
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
  const [submitted, setSubmitted] = useState(false)

  useBodyScrollLock()

  const errors = useMemo(() => {
    const e: { name?: string; sortOrder?: string } = {}
    const trimmedName = name.trim()
    if (!trimmedName) e.name = 'Name is required.'
    else if (trimmedName.length < 2) e.name = 'Name must be at least 2 characters.'
    else if (trimmedName.length > 100) e.name = 'Name must be at most 100 characters.'
    else if (!NAME_PATTERN.test(trimmedName))
      e.name = "Name can only contain letters, numbers, spaces, and & - ' . , ( )"
    if (row && sortOrder !== '' && (Number.isNaN(Number(sortOrder)) || !Number.isInteger(Number(sortOrder))))
      e.sortOrder = 'Sort order must be a whole number.'
    return e
  }, [name, sortOrder, row])
  const isValid = Object.keys(errors).length === 0

  function submit() {
    setSubmitted(true)
    if (!isValid) return
    run(
      () =>
        upsertMenuCategory({
          id: row?.id,
          name: name.trim(),
          // New categories are always appended server-side — see upsertMenuCategory.
          ...(row ? { sortOrder: sortOrder === '' ? 0 : Number(sortOrder) } : {}),
          isActive,
        }),
      () => {
        toast.success(row ? `Category "${name.trim()}" updated.` : `Category "${name.trim()}" added.`)
        onClose()
      },
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{row ? 'Edit category' : 'Add category'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Name <span className="text-destructive">*</span>
            </label>
            <input
              className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
              placeholder="e.g. Starters"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
            {submitted && errors.name && <p className={errorText}>{errors.name}</p>}
          </div>
          {row && (
            <div>
              <label className={label}>Sort order</label>
              <input
                className={`${input} ${submitted && errors.sortOrder ? inputInvalid : ''}`}
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
              {submitted && errors.sortOrder && <p className={errorText}>{errors.sortOrder}</p>}
            </div>
          )}
          <label className="flex items-center gap-2 text-base">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-base font-medium uppercase tracking-wide text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            disabled={pending}
            onClick={submit}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? 'Saving…' : row ? 'Save Changes' : 'Add Category'}
          </button>
        </div>
      </div>
    </div>
  )
}
