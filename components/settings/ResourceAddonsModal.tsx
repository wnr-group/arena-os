'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Loader2, Info } from 'lucide-react'
import { upsertResourceTypeAddon, deleteResourceTypeAddon } from '@/lib/actions/addons'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'

export type ResourceAddonRow = {
  id: string
  resourceTypeId: string
  name: string
  rate: string
  rateUnit: 'hour' | 'day'
  stockQuantity: number
  isActive: boolean
  sortOrder: number
}

type Draft = {
  name: string
  rate: string
  rateUnit: 'hour' | 'day'
  stockQuantity: string
  isActive: boolean
  sortOrder: string
}

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-xs font-medium text-muted-foreground'

const emptyDraft = (nextSortOrder: number): Draft => ({
  name: '',
  rate: '',
  rateUnit: 'hour',
  stockQuantity: '',
  isActive: true,
  sortOrder: String(nextSortOrder),
})

/**
 * Per-type "Add-ons" editor (M33) — optional priced extras (camera, lens, extra
 * equipment…) staff can attach to a booking of this resource type. Stock is a
 * real count pooled across the branch, so a unit rented out is unavailable to
 * every overlapping booking. Flat rate only: per hour or per day (a day bills
 * as each started 24 hours).
 */
export function ResourceAddonsModal({
  resourceTypeId,
  resourceTypeName,
  branchId,
  currency,
  addons,
  onClose,
}: {
  resourceTypeId: string
  resourceTypeName: string
  branchId: string
  currency: string
  addons: ResourceAddonRow[]
  onClose: () => void
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft(0))
  const [submitted, setSubmitted] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useBodyScrollLock()

  const rows = [...addons].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  const errors = (() => {
    const e: { name?: string; rate?: string; stock?: string } = {}
    if (!draft.name.trim()) e.name = 'Name is required.'
    if (draft.rate.trim() === '') e.rate = 'Rate is required.'
    else if (Number.isNaN(Number(draft.rate)) || Number(draft.rate) < 0) e.rate = 'Enter a rate of 0 or more.'
    if (draft.stockQuantity.trim() === '') e.stock = 'Stock is required.'
    else if (!/^\d+$/.test(draft.stockQuantity.trim())) e.stock = 'Enter a whole number, 0 or more.'
    return e
  })()
  const isValid = Object.keys(errors).length === 0

  function startAdd() {
    setEditingId(null)
    setSubmitted(false)
    setDraft(emptyDraft(rows.length))
    setAdding(true)
  }

  function startEdit(row: ResourceAddonRow) {
    setAdding(false)
    setSubmitted(false)
    setEditingId(row.id)
    setDraft({
      name: row.name,
      rate: row.rate,
      rateUnit: row.rateUnit,
      stockQuantity: String(row.stockQuantity),
      isActive: row.isActive,
      sortOrder: String(row.sortOrder),
    })
  }

  function cancelForm() {
    setAdding(false)
    setEditingId(null)
  }

  function submit(id?: string) {
    setSubmitted(true)
    if (!isValid) return
    const name = draft.name.trim()
    start(async () => {
      const r = await upsertResourceTypeAddon({
        id,
        resourceTypeId,
        branchId,
        name,
        rate: Number(draft.rate),
        rateUnit: draft.rateUnit,
        stockQuantity: Number(draft.stockQuantity),
        isActive: draft.isActive,
        sortOrder: Number(draft.sortOrder) || 0,
      })
      if (r.error) {
        toast.error(r.error)
      } else {
        toast.success(id ? `Add-on "${name}" updated.` : `Add-on "${name}" added.`)
        router.refresh()
        cancelForm()
      }
    })
  }

  async function handleDelete(row: ResourceAddonRow) {
    await confirm({
      title: `Delete add-on "${row.name}"?`,
      description: 'This cannot be undone. Past bookings keep their own frozen record of this add-on.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteResourceTypeAddon(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          toast.success(`Add-on "${row.name}" deleted.`)
          router.refresh()
        }
      },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 pt-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full border border-border/60 bg-background/90 p-1.5 text-muted-foreground shadow-sm backdrop-blur-sm transition hover:text-foreground"
        >
          <X size={16} />
        </button>

        <h2 className="text-xl font-semibold">Add-ons</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{resourceTypeName}</p>

        <div className="mt-3 flex gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
          <Info size={16} className="mt-0.5 shrink-0" />
          <p>
            Optional extras staff can rent out with a {resourceTypeName} booking — a camera, a lens, extra equipment.
            Stock is shared across this branch: units already rented for an overlapping time aren&rsquo;t available.
            A per-day add-on bills each started 24 hours as one day.
          </p>
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 && !adding && (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              No add-ons yet.
            </p>
          )}

          {rows.map((row) =>
            editingId === row.id ? (
              <AddonRowForm
                key={row.id}
                draft={draft}
                setDraft={setDraft}
                errors={errors}
                submitted={submitted}
                pending={pending}
                onCancel={cancelForm}
                onSubmit={() => submit(row.id)}
              />
            ) : (
              <AddonRowView
                key={row.id}
                row={row}
                currency={currency}
                pending={pending}
                deleting={deletingId === row.id}
                onEdit={() => startEdit(row)}
                onDelete={() => handleDelete(row)}
              />
            ),
          )}

          {adding && (
            <AddonRowForm
              draft={draft}
              setDraft={setDraft}
              errors={errors}
              submitted={submitted}
              pending={pending}
              onCancel={cancelForm}
              onSubmit={() => submit()}
            />
          )}
        </div>

        {!adding && editingId === null && (
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
            onClick={startAdd}
          >
            <Plus size={15} /> Add add-on
          </button>
        )}

        <div className="mt-5 flex justify-end">
          <button
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function AddonRowView({
  row,
  currency,
  pending,
  deleting,
  onEdit,
  onDelete,
}: {
  row: ResourceAddonRow
  currency: string
  pending: boolean
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{row.name}</span>
          {!row.isActive && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Inactive
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {formatMoney(row.rate, currency)} / {row.rateUnit === 'day' ? 'day' : 'hr'} · {row.stockQuantity} in stock
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          className="rounded-md p-1.5 text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onEdit}
          aria-label={`Edit ${row.name}`}
        >
          <Pencil size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onDelete}
          aria-label={`Delete ${row.name}`}
        >
          {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  )
}

function AddonRowForm({
  draft,
  setDraft,
  errors,
  submitted,
  pending,
  onCancel,
  onSubmit,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  errors: { name?: string; rate?: string; stock?: string }
  submitted: boolean
  pending: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="space-y-2.5 rounded-lg border border-primary/40 bg-primary/[0.03] p-3">
      <div>
        <label className={label}>
          Name <span className="text-destructive">*</span>
        </label>
        <input
          className={`${input} ${submitted && errors.name ? inputInvalid : ''}`}
          placeholder="e.g. DSLR camera"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          autoFocus
        />
        {submitted && errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={label}>
            Rate <span className="text-destructive">*</span>
          </label>
          <div className="flex gap-1.5">
            <input
              className={`${input} ${submitted && errors.rate ? inputInvalid : ''}`}
              placeholder="0.00"
              type="number"
              min="0"
              step="0.01"
              value={draft.rate}
              onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
            />
            <select
              className={input}
              value={draft.rateUnit}
              onChange={(e) => setDraft({ ...draft, rateUnit: e.target.value as 'hour' | 'day' })}
            >
              <option value="hour">Per hour</option>
              <option value="day">Per day</option>
            </select>
          </div>
          {submitted && errors.rate && <p className="mt-1 text-xs text-destructive">{errors.rate}</p>}
        </div>
        <div>
          <label className={label}>
            Stock <span className="text-destructive">*</span>
          </label>
          <input
            className={`${input} ${submitted && errors.stock ? inputInvalid : ''}`}
            placeholder="Units owned"
            type="number"
            min="0"
            step="1"
            value={draft.stockQuantity}
            onChange={(e) => setDraft({ ...draft, stockQuantity: e.target.value })}
          />
          {submitted && errors.stock && <p className="mt-1 text-xs text-destructive">{errors.stock}</p>}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2.5">
        <label className="flex items-center gap-1.5 text-sm text-foreground">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          />
          Active
        </label>
        <div className="flex items-center gap-1.5">
          <label className={label}>Sort order</label>
          <input
            className={`${input} w-16`}
            type="number"
            step="1"
            value={draft.sortOrder}
            onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-0.5">
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onSubmit}
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
      </div>
    </div>
  )
}
