'use client'

import { useState, useTransition, type ChangeEvent, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, X, Wallet, Receipt, FileText, Loader2, ExternalLink } from 'lucide-react'
import {
  createExpense,
  updateExpense,
  deleteExpense,
  uploadExpenseReceipt,
} from '@/lib/actions/expenses'
import { formatMoney, prettyDate } from '@/lib/format'
import type { ExpenseListItem, OptionRow } from '@/lib/expenses/data'

/**
 * The Expenses screen (AROS-108) — filter bar, total, table, add/edit modal.
 *
 * Same shape as the settings managers (TaxRatesManager et al): a server
 * component loads the data, this client component owns only the interaction,
 * and every mutation is a server action that re-checks the role. `run()` is the
 * shared submit path — it surfaces the action's error inline and refreshes the
 * server data on success, so the list and the total always come from Postgres
 * rather than being patched locally.
 *
 * Filters are URL state, not component state: applying pushes
 * ?from=&to=&category=&vendor= and lets the server re-query. That keeps a
 * filtered view linkable, makes the back button work, and — the point of the
 * ticket — means the total is always recomputed by SQL over the same predicate
 * as the rows.
 */

type Filters = { from: string; to: string; category: string; vendor: string }
type Modal = { mode: 'add' } | { mode: 'edit'; row: ExpenseListItem }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function ExpensesView({
  rows,
  total,
  count,
  categories,
  vendors,
  currency,
  timeZone,
  filters,
}: {
  rows: ExpenseListItem[]
  total: string
  count: number
  categories: OptionRow[]
  vendors: OptionRow[]
  currency: string
  timeZone: string
  filters: Filters
}) {
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

  function handleDelete(row: ExpenseListItem) {
    const what = `${formatMoney(row.amount, currency)} on ${row.spentOn}`
    if (!window.confirm(`Delete the expense of ${what}? This cannot be undone.`)) return
    run(() => deleteExpense(row.id))
  }

  const hasFilters = Boolean(filters.from || filters.to || filters.category || filters.vendor)

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <FilterBar filters={filters} categories={categories} vendors={vendors} />

      {/* ── total for the CURRENT filters, summed by Postgres ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          icon={Wallet}
          label={hasFilters ? 'Total (filtered)' : 'Total spent'}
          value={formatMoney(total, currency)}
        />
        <StatCard icon={Receipt} label={count === 1 ? 'Expense' : 'Expenses'} value={String(count)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All expenses</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add expense
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Note</th>
                <th className="px-4 py-3 font-medium">Receipt</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-base text-muted-foreground">
                    {hasFilters
                      ? 'No expenses match these filters. Widen the date range, or clear the filters.'
                      : 'No expenses yet. Add one to get started.'}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="whitespace-nowrap px-4 py-3">{prettyDate(row.spentOn, timeZone)}</td>
                  <td className="px-4 py-3">{row.categoryName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.vendorName ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMoney(row.amount, currency)}
                  </td>
                  <td className="max-w-[16rem] truncate px-4 py-3 text-muted-foreground" title={row.note ?? ''}>
                    {row.note ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.receiptUrl ? (
                      <a
                        href={row.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                      >
                        <Receipt size={15} /> View
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
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
        <ExpenseModal
          row={modal.mode === 'edit' ? modal.row : undefined}
          categories={categories}
          vendors={vendors}
          pending={pending}
          run={run}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

/**
 * Date range + category + vendor, applied together.
 *
 * One form pushing ALL four params at once, deliberately: pushing them
 * separately would drop whichever the other control was not carrying, which is
 * the trap a per-control filter falls into.
 */
function FilterBar({
  filters,
  categories,
  vendors,
}: {
  filters: Filters
  categories: OptionRow[]
  vendors: OptionRow[]
}) {
  const router = useRouter()
  const [from, setFrom] = useState(filters.from)
  const [to, setTo] = useState(filters.to)
  const [category, setCategory] = useState(filters.category)
  const [vendor, setVendor] = useState(filters.vendor)
  const [pending, startTransition] = useTransition()

  // A reversed range would return nothing and read as "no expenses" rather
  // than "bad input", so it is caught here before the navigation.
  const rangeError = from && to && from > to ? 'The From date must not be after the To date.' : null

  function apply(e: FormEvent) {
    e.preventDefault()
    if (rangeError) return
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    if (category) qs.set('category', category)
    if (vendor) qs.set('vendor', vendor)
    startTransition(() => router.push(qs.size ? `/expenses?${qs}` : '/expenses'))
  }

  function clear() {
    setFrom('')
    setTo('')
    setCategory('')
    setVendor('')
    startTransition(() => router.push('/expenses'))
  }

  return (
    <form onSubmit={apply} className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <input type="date" className={input} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" className={input} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Category">
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vendor">
          <select className={input} value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <button type="submit" className={`${btn} bg-primary text-primary-foreground`} disabled={pending || !!rangeError}>
            {pending ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className={`${btn} border`} onClick={clear} disabled={pending}>
            Clear
          </button>
        </div>
      </div>
      {rangeError && <p className="mt-2 text-sm text-destructive">{rangeError}</p>}
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-[9rem] flex-1 flex-col gap-1 sm:flex-none">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number }>
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

/**
 * The attached receipt: a thumbnail for an image, a document chip for a PDF.
 *
 * Which one is decided by the object key's extension, and that extension is
 * safe to trust because lib/storage/s3.ts writes it from its OWN MIME table —
 * the uploader's filename never reaches the key. No PDF renderer is pulled in;
 * a PDF opens in the browser's own viewer, which works because the upload
 * preserved `application/pdf` as the object's ContentType.
 */
function ReceiptPreview({ url, onRemove }: { url: string; onRemove: () => void }) {
  const isPdf = /\.pdf(\?|$)/i.test(url)

  return (
    <div className="mt-1.5 flex items-center gap-3 rounded-md border border-border bg-muted/30 p-2">
      {isPdf ? (
        <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <FileText size={22} />
        </span>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Receipt" className="h-14 w-14 rounded-md border object-cover" />
        </a>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{isPdf ? 'Receipt (PDF)' : 'Receipt image'}</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink size={12} /> View
        </a>
      </div>

      <button
        type="button"
        className="rounded-md p-1.5 text-destructive transition hover:bg-destructive/10"
        onClick={onRemove}
        aria-label="Remove receipt"
        title="Remove receipt"
      >
        <X size={15} />
      </button>
    </div>
  )
}

function ExpenseModal({
  row,
  categories,
  vendors,
  pending,
  run,
  onClose,
}: {
  row?: ExpenseListItem
  categories: OptionRow[]
  vendors: OptionRow[]
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [amount, setAmount] = useState(row?.amount ?? '')
  const [categoryId, setCategoryId] = useState(row?.categoryId ?? '')
  const [vendorId, setVendorId] = useState(row?.vendorId ?? '')
  const [spentOn, setSpentOn] = useState(row?.spentOn ?? '')
  const [note, setNote] = useState(row?.note ?? '')
  // The URL already stored (edit) or already uploaded (create). Clearing it to
  // '' is how "remove" is expressed; the action deletes the old object.
  const [receiptUrl, setReceiptUrl] = useState(row?.receiptUrl ?? '')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Mirrors the Zod rules in lib/actions/expenses.ts so the common mistakes are
  // caught before a round trip; the action re-checks all of them regardless.
  const amountNum = Number(amount)
  const invalid =
    amount.trim() === '' || !Number.isFinite(amountNum) || amountNum < 0 || !categoryId || !spentOn

  /**
   * Upload on selection, exactly as MenuItemsManager does: the file goes up
   * immediately and only its URL is submitted with the form. The <input> is
   * disabled while in flight, and Save is too, so a double-click cannot start a
   * second upload or submit a half-uploaded receipt.
   */
  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadError(null)
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    const r = await uploadExpenseReceipt(fd)
    setUploading(false)
    // Reset the input so re-picking the same file still fires onChange.
    e.target.value = ''
    // On failure the previous receipt stays exactly as it was — nothing has
    // been written, and the old object has not been touched.
    if (r.error) setUploadError(r.error)
    else if (r.url) setReceiptUrl(r.url)
  }

  function submit() {
    const payload = {
      amount: amountNum,
      categoryId,
      vendorId: vendorId || null,
      spentOn,
      note,
      receiptUrl: receiptUrl || null,
    }
    run(() => (row ? updateExpense(row.id, payload) : createExpense(payload)), onClose)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{row ? 'Edit expense' : 'Add expense'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Amount</label>
            <input
              className={input}
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Category</label>
            <select
              className={input}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={categories.length === 0}
            >
              <option value="">Select a category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* An expense REQUIRES a category (expenses.category_id is NOT NULL),
                so with none set up the form would otherwise be a silent dead
                end — the submit button just never enables. Say why. */}
            {categories.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">
                No expense categories exist yet. One is required before an expense can be recorded.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Vendor (optional)</label>
            <select className={input} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">No vendor</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Spent on</label>
            <input className={input} type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Note (optional)</label>
            <input
              className={input}
              placeholder="e.g. August rent"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Receipt (optional)</label>
            {receiptUrl && <ReceiptPreview url={receiptUrl} onRemove={() => setReceiptUrl('')} />}
            <label
              className={`${btn} mt-1.5 inline-flex w-full cursor-pointer items-center justify-center gap-2 border ${
                uploading ? 'cursor-not-allowed opacity-50' : ''
              }`}
            >
              {uploading && <Loader2 size={15} className="animate-spin" />}
              {uploading ? 'Uploading…' : receiptUrl ? 'Replace receipt' : 'Upload receipt'}
              <input
                type="file"
                // A hint for the picker only — the real gate is server-side in
                // lib/storage/s3.ts, which re-checks type, size and emptiness.
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                className="hidden"
                disabled={uploading}
                onChange={handleFile}
              />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">Supported: JPG, PNG, WebP, GIF, PDF · max 5MB</p>
            {uploadError && <p className="mt-1 text-xs text-destructive">{uploadError}</p>}
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex-1 bg-primary text-primary-foreground`}
            disabled={pending || uploading || invalid}
            onClick={submit}
          >
            {row ? 'Save changes' : 'Add expense'}
          </button>
          <button className={`${btn} border`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
