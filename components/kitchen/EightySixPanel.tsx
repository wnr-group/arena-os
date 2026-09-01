'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, PackageCheck, PackageX, Search, X } from 'lucide-react'
import { setMenuItemAvailability } from '@/lib/actions/menu'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'

export type EightySixItem = {
  id: string
  name: string
  categoryName: string
  status: 'available' | 'out_of_stock'
}

/**
 * The KDS's "86 items" quick-access panel (M17 #7) — every kitchen staff
 * member needs a one-tap way to mark a dish out of stock mid-service, from
 * the same screen they're already working. setMenuItemAvailability
 * re-checks canManageKitchen() server-side; this panel has no role gate of
 * its own, same convention as the KOT advance buttons on this page.
 */
export function EightySixPanel({ items, onClose }: { items: EightySixItem[]; onClose: () => void }) {
  useBodyScrollLock()
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.name.toLowerCase().includes(q) || i.categoryName.toLowerCase().includes(q))
  }, [items, search])

  function toggle(item: EightySixItem) {
    const next = item.status === 'out_of_stock' ? 'available' : 'out_of_stock'
    setError(null)
    setTogglingId(item.id)
    startTransition(async () => {
      const r = await setMenuItemAvailability({ id: item.id, status: next })
      if (r.error) setError(r.error)
      else router.refresh()
      setTogglingId(null)
    })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="86 items"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-base font-semibold">86 items</h2>
            <p className="text-xs text-muted-foreground">Mark a dish out of stock — it disappears from every order screen instantly.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
            <input
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        {error && (
          <p className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No items match.</p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((item) => {
                const outOfStock = item.status === 'out_of_stock'
                const isToggling = togglingId === item.id
                return (
                  <li
                    key={item.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                      outOfStock ? 'border-amber-500/30 bg-amber-500/5' : 'border-border'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{item.categoryName}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(item)}
                      disabled={isToggling}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        outOfStock
                          ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'
                          : 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                      }`}
                    >
                      {isToggling ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : outOfStock ? (
                        <PackageCheck size={13} />
                      ) : (
                        <PackageX size={13} />
                      )}
                      {outOfStock ? 'Un-86' : '86'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
