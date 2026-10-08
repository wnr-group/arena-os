'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, PackagePlus } from 'lucide-react'
import { listAddonsForResources } from '@/lib/actions/addons'
import { addonBillableUnits } from '@/lib/booking/addon-pricing'
import type { AvailableAddon } from '@/lib/booking/addons'
import { formatMoney } from '@/lib/format'

export type AddonSelection = { addonId: string; quantity: number }

/** What the add-ons in `selection` cost for a window — the same arithmetic
 *  the server runs (addonBillableUnits), shown as an ESTIMATE: the server
 *  re-prices and re-checks stock when the booking is actually created.
 *  `endsAt` null = an open tab, which has no total until checkout. */
export function estimateAddonTotal(
  selection: AddonSelection[],
  available: AvailableAddon[],
  startsAt: string,
  endsAt: string | null,
): number {
  if (!endsAt) return 0
  let total = 0
  for (const s of selection) {
    const a = available.find((x) => x.id === s.addonId)
    if (!a) continue
    total += Number(a.rate) * s.quantity * addonBillableUnits(a.rateUnit, new Date(startsAt), new Date(endsAt))
  }
  return Math.round(total * 100) / 100
}

/**
 * Optional add-ons (camera, lens, …) for ONE resource over a window, with live
 * free-stock counts. Controlled: the parent owns `value` and sends it with the
 * booking. Stock shown is a convenience — the server re-checks it under a lock,
 * so a stale count can only ever be refused, never oversold.
 *
 * Renders nothing when the resource's type has no active add-ons at the
 * branch, so industries/types that don't use the feature see no change.
 */
export function AddonPicker({
  branchId,
  resourceId,
  startsAt,
  endsAt,
  currency,
  value,
  onChange,
  onAvailable,
}: {
  branchId: string
  resourceId: string
  startsAt: string
  /** Null for an open-tab walk-in (priced at checkout). */
  endsAt: string | null
  currency: string
  value: AddonSelection[]
  onChange: (next: AddonSelection[]) => void
  /** Reports the loaded catalog so the parent can estimate a total. */
  onAvailable?: (available: AvailableAddon[]) => void
}) {
  const [available, setAvailable] = useState<AvailableAddon[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listAddonsForResources({ branchId, resourceIds: [resourceId], startsAt, endsAt }).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (r.error) {
        setError(r.error)
        setAvailable([])
        return
      }
      const list = r.byResource?.[resourceId] ?? []
      setAvailable(list)
      // Drop selections that no longer exist / no longer fit this window.
      onChange(
        value
          .map((v) => {
            const a = list.find((x) => x.id === v.addonId)
            return a ? { addonId: v.addonId, quantity: Math.min(v.quantity, a.available) } : null
          })
          .filter((v): v is AddonSelection => v !== null && v.quantity > 0),
      )
    })
    return () => {
      cancelled = true
    }
    // value/onChange intentionally omitted: this refetches only when the
    // resource or window changes, and reconciles the current selection once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, resourceId, startsAt, endsAt])

  useEffect(() => {
    onAvailable?.(available)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available])

  const qtyOf = (id: string) => value.find((v) => v.addonId === id)?.quantity ?? 0
  const setQty = (id: string, q: number) => {
    const rest = value.filter((v) => v.addonId !== id)
    onChange(q > 0 ? [...rest, { addonId: id, quantity: q }] : rest)
  }

  const total = useMemo(() => estimateAddonTotal(value, available, startsAt, endsAt), [value, available, startsAt, endsAt])

  if (!loading && !error && available.length === 0) return null

  return (
    <div className="rounded-xl border border-border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <PackagePlus size={15} className="text-primary" />
        Add-ons
        <span className="text-xs font-normal text-muted-foreground">optional</span>
        {loading && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 space-y-2">
        {available.map((a) => {
          const q = qtyOf(a.id)
          const soldOut = a.available <= 0
          return (
            <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(Number(a.rate), currency)} / {a.rateUnit === 'day' ? 'day' : 'hr'} ·{' '}
                  {soldOut ? 'out of stock' : `${a.available} available`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`Fewer ${a.name}`}
                  disabled={q <= 0}
                  onClick={() => setQty(a.id, q - 1)}
                  className="rounded-md border border-border px-2.5 py-1 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm font-semibold tabular-nums">{q}</span>
                <button
                  type="button"
                  aria-label={`More ${a.name}`}
                  disabled={q >= a.available}
                  onClick={() => setQty(a.id, q + 1)}
                  className="rounded-md border border-border px-2.5 py-1 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {value.length > 0 && (
        <p className="mt-3 text-right text-sm text-muted-foreground">
          {endsAt ? (
            <>
              Add-ons: <span className="font-semibold text-foreground">{formatMoney(total, currency)}</span>
            </>
          ) : (
            'Add-ons are priced at checkout.'
          )}
        </p>
      )}
    </div>
  )
}
