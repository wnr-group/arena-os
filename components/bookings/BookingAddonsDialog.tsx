'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, PackagePlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { formatMoney } from '@/lib/format'
import {
  loadBookingAddonEditor,
  setBookingSlotAddons,
  type BookingAddonEditorSlot,
} from '@/lib/actions/addons'

type Qty = Record<string, number> // addonId -> quantity

/**
 * M33 correction tool: add, remove or change the quantity of a booking's
 * add-ons while it is still unbilled — same "fix it in place" shape as M25's
 * corrections. The server owns every rule (unbilled, open booking, stock under
 * a lock, frozen name/rate for add-ons already on the booking); this dialog
 * only edits the desired set per slot and reports whatever the server refuses.
 */
export function BookingAddonsDialog({
  bookingId,
  bookingLabel,
  currency,
  onClose,
  onSaved,
}: {
  bookingId: string
  bookingLabel: string
  currency: string
  onClose: () => void
  onSaved: () => void
}) {
  useBodyScrollLock()
  const [slots, setSlots] = useState<BookingAddonEditorSlot[] | null>(null)
  const [draft, setDraft] = useState<Record<string, Qty>>({}) // slotId -> qty map
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    let cancelled = false
    loadBookingAddonEditor(bookingId).then((r) => {
      if (cancelled) return
      if (r.error || !r.slots) {
        setLoadError(r.error ?? 'Could not load add-ons.')
        return
      }
      setSlots(r.slots)
      const d: Record<string, Qty> = {}
      for (const s of r.slots) {
        d[s.slotId] = {}
        // A row whose catalog entry was deleted (addonId null) has no id to
        // edit by — it stays on the booking untouched and is shown read-only.
        for (const c of s.current) if (c.addonId) d[s.slotId][c.addonId] = c.quantity
      }
      setDraft(d)
    })
    return () => {
      cancelled = true
    }
  }, [bookingId])

  function setQty(slotId: string, addonId: string, q: number) {
    setDraft((d) => ({ ...d, [slotId]: { ...d[slotId], [addonId]: Math.max(0, q) } }))
  }

  function save() {
    if (!slots) return
    setError(null)
    start(async () => {
      for (const s of slots) {
        const wanted = Object.entries(draft[s.slotId] ?? {})
          .filter(([, q]) => q > 0)
          .map(([addonId, quantity]) => ({ addonId, quantity }))
        const before = s.current
          .filter((c) => c.addonId)
          .map((c) => `${c.addonId}:${c.quantity}`)
          .sort()
          .join(',')
        const after = wanted
          .map((w) => `${w.addonId}:${w.quantity}`)
          .sort()
          .join(',')
        if (before === after) continue
        const r = await setBookingSlotAddons({ bookingId, bookingSlotId: s.slotId, addons: wanted })
        if (r.error) {
          setError(r.error)
          return
        }
      }
      toast.success('Add-ons updated.')
      onSaved()
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={pending ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          disabled={pending}
          className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        >
          <X size={16} />
        </button>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <PackagePlus size={16} className="text-primary" /> Add-ons
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{bookingLabel}</p>

        {loadError ? (
          <p className="mt-4 text-sm text-destructive">{loadError}</p>
        ) : !slots ? (
          <div className="mt-6 flex justify-center">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {slots.every((s) => s.available.length === 0 && s.current.length === 0) && (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No add-ons are set up for this booking&rsquo;s resource.
              </p>
            )}
            {slots.map((s) => {
              // Catalog rows already on the booking but no longer active still
              // belong in the editor, so they can be reduced or removed.
              const rows = [
                ...s.available.map((a) => ({
                  id: a.id,
                  name: a.name,
                  rateUnit: a.rateUnit,
                  rate: a.rate,
                  max: a.available,
                })),
                ...s.current
                  .filter((c) => c.addonId && !s.available.some((a) => a.id === c.addonId))
                  .map((c) => ({
                    id: c.addonId as string,
                    name: c.name,
                    rateUnit: c.rateUnit,
                    rate: c.rateApplied,
                    max: c.quantity, // retired: may be reduced or removed, not grown
                  })),
              ]
              const orphans = s.current.filter((c) => !c.addonId)
              if (rows.length === 0 && orphans.length === 0) return null
              return (
                <div key={s.slotId}>
                  {slots.length > 1 && <p className="mb-2 text-sm font-semibold">{s.resourceName}</p>}
                  <div className="space-y-2">
                    {rows.map((r) => {
                      const q = draft[s.slotId]?.[r.id] ?? 0
                      // Existing add-ons price at the booking's frozen rate —
                      // show that, not the live catalog rate.
                      const frozen = s.current.find((c) => c.addonId === r.id)
                      const rate = frozen ? frozen.rateApplied : r.rate
                      const unit = frozen ? frozen.rateUnit : r.rateUnit
                      return (
                        <div
                          key={r.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{r.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatMoney(Number(rate), currency)} / {unit === 'day' ? 'day' : 'hr'} ·{' '}
                              {r.max <= 0 && q === 0 ? 'out of stock' : `up to ${Math.max(r.max, q)}`}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`Fewer ${r.name}`}
                              disabled={pending || q <= 0}
                              onClick={() => setQty(s.slotId, r.id, q - 1)}
                              className="rounded-md border border-border px-2.5 py-1 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                            >
                              −
                            </button>
                            <span className="w-6 text-center text-sm font-semibold tabular-nums">{q}</span>
                            <button
                              type="button"
                              aria-label={`More ${r.name}`}
                              disabled={pending || q >= Math.max(r.max, 0)}
                              onClick={() => setQty(s.slotId, r.id, q + 1)}
                              className="rounded-md border border-border px-2.5 py-1 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    {orphans.map((o) => (
                      <p key={o.id} className="px-1 text-xs text-muted-foreground">
                        {o.name} × {o.quantity} — removed from the catalog, kept on this booking.
                      </p>
                    ))}
                  </div>
                </div>
              )
            })}
            <p className="text-xs text-muted-foreground">
              Add-ons already on the booking keep the price they were added at. Changes are blocked once the booking
              has been billed.
            </p>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
            onClick={onClose}
            disabled={pending}
          >
            Close
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            onClick={save}
            disabled={pending || !slots}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Save add-ons
          </button>
        </div>
      </div>
    </div>
  )
}
