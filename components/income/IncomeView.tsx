'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, X, PiggyBank, ListOrdered } from 'lucide-react'
import { createIncome, updateIncome, deleteIncome } from '@/lib/actions/income'
import { formatMoney, prettyDate } from '@/lib/format'
import type { IncomeListItem } from '@/lib/income/data'

/**
 * The Other income screen (M40 / AROS-359): total for the range, table, add/edit
 * modal. Same shape as ExpensesView, smaller: no category, vendor or receipt.
 *
 * The page is manager-only, so every control here is already behind the server
 * page's guard; the actions re-check the role and RLS is the real boundary.
 * `run()` surfaces the action's error inline and refreshes the server data on
 * success, so the list and total always come from Postgres, never patched here.
 */

type Modal = { mode: 'add' } | { mode: 'edit'; row: IncomeListItem }
type Run = (fn: () => Promise<{ error?: string }>, onSuccess?: () => void) => void

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

export function IncomeView({
  rows,
  total,
  count,
  currency,
  timeZone,
  today,
}: {
  rows: IncomeListItem[]
  total: string
  count: number
  currency: string
  timeZone: string
  today: string
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

  function handleDelete(row: IncomeListItem) {
    const what = `${formatMoney(row.amount, currency)} on ${row.receivedOn}`
    if (!window.confirm(`Delete the income entry of ${what}? This cannot be undone.`)) return
    run(() => deleteIncome(row.id))
  }

  return (
    <div className="mt-6 space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── total for the CURRENT range, summed by Postgres ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard icon={PiggyBank} label="Total received (this range)" value={formatMoney(total, currency)} />
        <StatCard icon={ListOrdered} label={count === 1 ? 'Entry' : 'Entries'} value={String(count)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Entries</h2>
        <button
          className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          onClick={() => setModal({ mode: 'add' })}
        >
          <Plus size={15} /> Add income
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Note</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-base text-muted-foreground">
                    No income recorded in this range. Add an entry, or widen the dates.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="transition hover:bg-muted/20">
                  <td className="whitespace-nowrap px-4 py-3">{prettyDate(row.receivedOn, timeZone)}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatMoney(row.amount, currency)}
                  </td>
                  <td className="max-w-[16rem] truncate px-4 py-3 text-muted-foreground" title={row.note ?? ''}>
                    {row.note ?? '—'}
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
        <IncomeModal
          // Remount per target so the fields re-seed from the row being edited.
          key={modal.mode === 'edit' ? modal.row.id : 'add'}
          row={modal.mode === 'edit' ? modal.row : undefined}
          today={today}
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

function IncomeModal({
  row,
  today,
  pending,
  run,
  onClose,
}: {
  row?: IncomeListItem
  today: string
  pending: boolean
  run: Run
  onClose: () => void
}) {
  const [amount, setAmount] = useState(row?.amount ?? '')
  const [receivedOn, setReceivedOn] = useState(row?.receivedOn ?? today)
  const [note, setNote] = useState(row?.note ?? '')

  // Mirrors the Zod rules in lib/actions/income.ts so common mistakes are caught
  // before a round trip; the action re-checks all of them regardless.
  const amountNum = Number(amount)
  const invalid =
    amount.trim() === '' || !Number.isFinite(amountNum) || amountNum < 0 || !receivedOn || note.length > 500

  function submit() {
    const payload = { amount: amountNum, receivedOn, note }
    run(() => (row ? updateIncome(row.id, payload) : createIncome(payload)), onClose)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{row ? 'Edit income' : 'Add income'}</h2>
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
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Date received</label>
            <input className={input} type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Note (optional)</label>
            <input
              className={input}
              placeholder="e.g. Owner investment"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Not a sale — this appears on the Profit &amp; Loss report, not in Revenue.
            </p>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className={`${btn} flex-1 bg-primary text-primary-foreground`}
            disabled={pending || invalid}
            onClick={submit}
          >
            {row ? 'Save changes' : 'Add income'}
          </button>
          <button className={`${btn} border`} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
