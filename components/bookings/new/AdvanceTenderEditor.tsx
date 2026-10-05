'use client'

import { Banknote, CreditCard, Plus, Smartphone, Trash2, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatMoney } from '@/lib/format'
import {
  ADVANCE_METHODS,
  ADVANCE_METHOD_LABELS,
  cleanAdvanceTenders,
  sumAdvanceTenders,
  type AdvanceMethod,
  type AdvanceTenderRow,
} from './advance-tenders'

const METHOD_ICONS: Record<AdvanceMethod, ReactNode> = {
  cash: <Banknote size={15} aria-hidden />,
  card: <CreditCard size={15} aria-hidden />,
  upi: <Smartphone size={15} aria-hidden />,
}

function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-IN', { style: 'currency', currency })
      .formatToParts(0)
      .find((p) => p.type === 'currency')
    return part?.value ?? currency
  } catch {
    return currency
  }
}

/**
 * "Collected upfront" entry for the staff wizards (M30 #5) — a repeatable list
 * of { method, amount } rows, the pre-bill sibling of PaymentPanel's split
 * tender. Starts empty (nothing collected is the default); the parent owns the
 * rows and sends cleanAdvanceTenders(rows) on submit. The running total is
 * computed from that same cleaned list, so it matches what gets recorded.
 *
 * Rendered only for gaming_cafe (the parent's advancePaymentEnabled gate) —
 * this component adds no gating of its own.
 */
export function AdvanceTenderEditor({
  idPrefix,
  rows,
  onChange,
  currency,
  hint,
}: {
  idPrefix: string
  rows: AdvanceTenderRow[]
  onChange: (rows: AdvanceTenderRow[]) => void
  currency: string
  hint: string
}) {
  const sent = cleanAdvanceTenders(rows)
  const total = sumAdvanceTenders(sent)
  const symbol = currencySymbol(currency)

  const update = (key: number, patch: Partial<Pick<AdvanceTenderRow, 'method' | 'amount'>>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, { key: Math.max(0, ...rows.map((r) => r.key)) + 1, method: 'cash', amount: '' }])

  return (
    <section
      aria-labelledby={`${idPrefix}-title`}
      className="overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-card to-muted/10 shadow-sm"
    >
      {/* Header */}
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <Wallet size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={`${idPrefix}-title`} className="text-sm font-semibold text-foreground">
              Collected upfront
            </h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Optional
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
      </div>

      {/* Tender rows */}
      {rows.length > 0 && (
        <ul className="space-y-3 px-4 pb-1 sm:px-5">
          {rows.map((r, i) => (
            <li
              key={r.key}
              className="wizard-step-in rounded-xl border border-border bg-background/70 p-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {/* Method — segmented chips */}
                <div
                  role="radiogroup"
                  aria-label={`Tender ${i + 1} method`}
                  className="grid grid-cols-3 gap-1 rounded-lg bg-muted/70 p-1 sm:w-auto sm:shrink-0"
                >
                  {ADVANCE_METHODS.map((m) => {
                    const active = r.method === m
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => update(r.key, { method: m })}
                        className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 ${
                          active
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-background hover:text-foreground'
                        }`}
                      >
                        {METHOD_ICONS[m]}
                        {ADVANCE_METHOD_LABELS[m]}
                      </button>
                    )
                  })}
                </div>

                {/* Amount + remove */}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-base font-medium text-muted-foreground"
                    >
                      {symbol}
                    </span>
                    <input
                      id={`${idPrefix}-amount-${r.key}`}
                      aria-label={`Tender ${i + 1} amount`}
                      className="min-h-11 w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3.5 text-base font-semibold tabular-nums outline-none transition placeholder:font-normal focus:border-primary focus:ring-2 focus:ring-ring/40"
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={r.amount}
                      onChange={(e) => update(r.key, { amount: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove tender ${i + 1}`}
                    onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground outline-none transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add / total footer */}
      {rows.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <button
            type="button"
            onClick={add}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-primary/40 bg-accent/30 px-4 text-sm font-semibold text-primary outline-none transition hover:border-primary hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Plus size={16} aria-hidden />
            Add a payment
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3 border-t border-border/70 bg-muted/40 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <button
            type="button"
            onClick={add}
            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-foreground outline-none transition hover:border-primary/40 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 sm:justify-start"
          >
            <Plus size={15} aria-hidden />
            Add another
          </button>
          <p className="flex items-baseline justify-between gap-3 sm:justify-end" aria-live="polite">
            <span className="text-xs text-muted-foreground">
              {sent.length === 0
                ? 'Enter an amount'
                : `${sent.length} ${sent.length === 1 ? 'tender' : 'tenders'} · collected upfront`}
            </span>
            <span className="text-lg font-bold tabular-nums text-foreground">{formatMoney(total, currency)}</span>
          </p>
        </div>
      )}
    </section>
  )
}
