'use client'

import { Loader2, Minus, PackagePlus, Plus } from 'lucide-react'
import type { PublicTypeAddon } from '@/lib/booking/public-availability'
import { formatMoney } from '@/lib/format'

/**
 * M35 #4: the public add-on picker, shown once a time (so a stock window) is
 * chosen. `available` is the live per-add-on count for that window from
 * getPublicAddonAvailabilityForWindow (null while it loads); each stepper is
 * capped at it and an add-on at 0 reads "Unavailable". Prices are shown as
 * rate/unit only — line totals come from the server quote in the summary.
 */
export function AddonPicker({
  catalog,
  currency,
  quantities,
  available,
  notice,
  error,
  onChange,
}: {
  catalog: PublicTypeAddon[]
  currency: string
  quantities: Record<string, number>
  available: Record<string, number> | null
  notice: string | null
  error: string | null
  onChange: (addonId: string, quantity: number) => void
}) {
  return (
    <section aria-labelledby="addons-heading">
      <h2 id="addons-heading" className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <PackagePlus size={14} /> Add-ons
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">Optional extras for your slot.</p>

      {notice && (
        <p role="status" className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-sm text-foreground">
          {notice}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <ul className="mt-3 space-y-2">
        {catalog.map((a) => {
          const loading = available === null && !error
          const cap = available?.[a.id] ?? 0
          const qty = quantities[a.id] ?? 0
          const unavailable = available !== null && cap <= 0
          return (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(a.rate, currency)} / {a.rateUnit === 'day' ? 'day' : 'hr'}
                </p>
              </div>
              {unavailable ? (
                <span className="shrink-0 text-xs font-semibold text-muted-foreground">Unavailable</span>
              ) : loading ? (
                <Loader2 size={16} className="shrink-0 animate-spin text-muted-foreground" aria-label="Checking stock" />
              ) : (
                <div role="group" aria-label={`${a.name} quantity`} className="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onChange(a.id, Math.max(0, qty - 1))}
                    disabled={qty <= 0}
                    aria-label={`Fewer ${a.name}`}
                    className="flex size-9 items-center justify-center rounded-full border border-border text-foreground transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Minus size={14} />
                  </button>
                  <span className="w-5 text-center text-sm font-bold tabular-nums" aria-live="polite">
                    {qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange(a.id, Math.min(cap, qty + 1))}
                    disabled={qty >= cap}
                    aria-label={`More ${a.name}`}
                    className="flex size-9 items-center justify-center rounded-full border border-border text-foreground transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
