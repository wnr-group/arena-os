'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, X, Loader2, Info } from 'lucide-react'
import { upsertHolidayRate, deleteHolidayRate } from '@/lib/actions/resources'
import { formatMoney, prettyDate } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { useConfirm } from '@/components/ui/ConfirmDialog'

export type HolidayRateRow = {
  id: string
  resourceTypeId: string
  /** Plain calendar date, `YYYY-MM-DD` — see db/schema.ts's holidayRates.date comment. */
  date: string
  rate: string
}

type Draft = { date: string; rate: string }

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const inputInvalid = 'border-destructive focus:border-destructive focus:ring-destructive/30'
const label = 'text-xs font-medium text-muted-foreground'

const emptyDraft = (): Draft => ({ date: '', rate: '' })

/**
 * Per-type "Holiday rates" editor (M27 #3) — a fixed, undiscountable rate for
 * ONE resource type on ONE literal calendar date (a public holiday, a
 * festival, a one-off event), overriding both weekend pricing and any active
 * happy-hour rule for a booking whose slot starts that day (M27 #2). Not a
 * recurring rule (v1 boundary) — the owner re-adds it each year if needed.
 */
export function HolidayRatesModal({
  resourceTypeId,
  resourceTypeName,
  currency,
  rates,
  onClose,
}: {
  resourceTypeId: string
  resourceTypeName: string
  currency: string
  rates: HolidayRateRow[]
  onClose: () => void
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [submitted, setSubmitted] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useBodyScrollLock()

  // CodeRabbit review: ResourceSetupsModal (the M24 template this mirrors)
  // and even the app-wide ConfirmDialog stop at role/aria-modal/Escape —
  // neither traps Tab/Shift+Tab or restores focus on close. Adding the full
  // set here rather than the partial precedent: focus moves into the modal
  // on open, Tab/Shift+Tab cycle within it (never reaching the settings
  // page behind it), Escape closes it, and focus returns to whatever
  // triggered it (the type row's "Holiday rates" button) on close.
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = 'holiday-rates-modal-title'
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const first = panelRef.current?.querySelector<HTMLElement>(focusableSelector)
    first?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      // Re-queried on every Tab press, not just on mount — the modal's own
      // content changes (add/edit forms open and close, rows are added),
      // so a snapshot taken once would trap focus against stale elements.
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
      if (focusable.length === 0) return
      const firstEl = focusable[0]
      const lastEl = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = [...rates].sort((a, b) => a.date.localeCompare(b.date))

  const errors = (() => {
    const e: { date?: string; rate?: string } = {}
    if (!draft.date) e.date = 'Pick a date.'
    if (draft.rate.trim() === '') e.rate = 'Rate is required.'
    else if (Number.isNaN(Number(draft.rate)) || Number(draft.rate) < 0) e.rate = 'Enter a rate of 0 or more.'
    return e
  })()
  const isValid = Object.keys(errors).length === 0

  function startAdd() {
    setEditingId(null)
    setSubmitted(false)
    setDraft(emptyDraft())
    setAdding(true)
  }

  function startEdit(row: HolidayRateRow) {
    setAdding(false)
    setSubmitted(false)
    setEditingId(row.id)
    setDraft({ date: row.date, rate: row.rate })
  }

  function cancelForm() {
    setAdding(false)
    setEditingId(null)
  }

  // M27 #3's own design note: picking a date that already has an entry
  // pre-fills its rate, so saving reads as "update this" rather than risking
  // a silent overwrite of a rate the owner didn't realize was already there.
  // Only meaningful while ADDING — editing a specific row already shows that
  // row's own rate, and re-picking its date to itself must not clobber the
  // in-progress edit with a duplicate lookup of the same row.
  function onDateChange(date: string) {
    if (adding) {
      const existing = rows.find((r) => r.date === date)
      setDraft({ date, rate: existing ? existing.rate : draft.rate })
    } else {
      setDraft({ ...draft, date })
    }
  }

  function submit(id?: string) {
    setSubmitted(true)
    if (!isValid) return
    const date = draft.date
    start(async () => {
      const r = await upsertHolidayRate({ id, resourceTypeId, date, rate: Number(draft.rate) })
      if (r.error) {
        toast.error(r.error)
      } else {
        toast.success(id ? `Holiday rate for ${prettyDate(date)} updated.` : `Holiday rate for ${prettyDate(date)} added.`)
        router.refresh()
        cancelForm()
      }
    })
  }

  async function handleDelete(row: HolidayRateRow) {
    await confirm({
      title: `Delete the holiday rate for ${prettyDate(row.date)}?`,
      description: 'This cannot be undone. Past bookings keep their own frozen record of what they billed.',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeletingId(row.id)
        const r = await deleteHolidayRate(row.id)
        setDeletingId(null)
        if (r.error) {
          toast.error(r.error)
        } else {
          toast.success(`Holiday rate for ${prettyDate(row.date)} deleted.`)
          router.refresh()
        }
      },
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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

        <h2 id={titleId} className="text-xl font-semibold">
          Holiday rates
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{resourceTypeName}</p>

        <div className="mt-3 flex gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
          <Info size={16} className="mt-0.5 shrink-0" />
          <p>
            A booking that starts on one of these dates bills this fixed rate — no weekend pricing, no happy-hour
            discount underneath it. Leave it empty and every date prices as usual.
          </p>
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 && !adding && (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              No holiday rates yet.
            </p>
          )}

          {rows.map((row) =>
            editingId === row.id ? (
              <HolidayRateRowForm
                key={row.id}
                draft={draft}
                onDateChange={onDateChange}
                setDraft={setDraft}
                errors={errors}
                submitted={submitted}
                pending={pending}
                onCancel={cancelForm}
                onSubmit={() => submit(row.id)}
              />
            ) : (
              <HolidayRateRowView
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
            <HolidayRateRowForm
              draft={draft}
              onDateChange={onDateChange}
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
            <Plus size={15} /> Add holiday rate
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

function HolidayRateRowView({
  row,
  currency,
  pending,
  deleting,
  onEdit,
  onDelete,
}: {
  row: HolidayRateRow
  currency: string
  pending: boolean
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{prettyDate(row.date)}</p>
        <p className="text-sm text-muted-foreground">{formatMoney(row.rate, currency)}/hr</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          className="rounded-md p-1.5 text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onEdit}
          aria-label={`Edit holiday rate for ${row.date}`}
        >
          <Pencil size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={pending}
          onClick={onDelete}
          aria-label={`Delete holiday rate for ${row.date}`}
        >
          {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  )
}

function HolidayRateRowForm({
  draft,
  onDateChange,
  setDraft,
  errors,
  submitted,
  pending,
  onCancel,
  onSubmit,
}: {
  draft: Draft
  onDateChange: (date: string) => void
  setDraft: (d: Draft) => void
  errors: { date?: string; rate?: string }
  submitted: boolean
  pending: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="space-y-2.5 rounded-lg border border-primary/40 bg-primary/[0.03] p-3">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={label}>
            Date <span className="text-destructive">*</span>
          </label>
          <input
            className={`${input} ${submitted && errors.date ? inputInvalid : ''}`}
            type="date"
            value={draft.date}
            onChange={(e) => onDateChange(e.target.value)}
            autoFocus
          />
          {submitted && errors.date && <p className="mt-1 text-xs text-destructive">{errors.date}</p>}
        </div>
        <div>
          <label className={label}>
            Rate (per hour) <span className="text-destructive">*</span>
          </label>
          <input
            className={`${input} ${submitted && errors.rate ? inputInvalid : ''}`}
            placeholder="0.00"
            type="number"
            min="0"
            step="0.01"
            value={draft.rate}
            onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
          />
          {submitted && errors.rate && <p className="mt-1 text-xs text-destructive">{errors.rate}</p>}
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
