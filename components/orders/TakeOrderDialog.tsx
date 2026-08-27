'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Plus, Minus, X, Search, Loader2, ShoppingCart, Zap } from 'lucide-react'
import { createOrder } from '@/lib/actions/orders'
import { formatMoney } from '@/lib/format'
import { applyHappyHour, activeHappyHours, type HappyHourRule } from '@/lib/happy-hours/apply'

export type CategoryOption = { id: string; name: string }
export type MenuItemOption = {
  id: string
  name: string
  price: string
  categoryId: string
  categoryName: string
  taxPercent: string | null
}
type CartLine = {
  menuItemId: string
  name: string
  price: string
  taxPercent: string | null
  qty: number
  specialInstructions: string
}

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

export function TakeOrderDialog({
  branchId,
  bookingId,
  bookingLabel,
  currency,
  categories,
  menuItems,
  happyHours,
  timeZone,
  onClose,
  onCreated,
}: {
  branchId: string
  bookingId?: string
  bookingLabel?: string
  currency: string
  categories: CategoryOption[]
  menuItems: MenuItemOption[]
  happyHours: HappyHourRule[]
  timeZone: string
  onClose: () => void
  onCreated: (orderNumber: string) => void
}) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [cart, setCart] = useState<CartLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // Idempotency (migration 0058) — stable for as long as this dialog stays
  // open, so a network retry or an impatient double-tap on "Place order"
  // never cooks the food twice. The dialog unmounts on success (onCreated
  // closes it), so a fresh key for the next order comes for free on remount.
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  // Snapshotting "now" once per open keeps every price in the dialog
  // consistent with itself; the server re-evaluates for real at submit time,
  // so this is a preview only — never trusted for the actual charge.
  const now = useMemo(() => new Date(), [])
  const liveRules = useMemo(() => activeHappyHours(happyHours, now, timeZone), [happyHours, now, timeZone])
  const priced = useCallback(
    (price: string) => applyHappyHour(Number(price), happyHours, now, timeZone),
    [happyHours, now, timeZone],
  )

  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menuItems.filter((m) => {
      if (categoryFilter !== 'all' && m.categoryId !== categoryFilter) return false
      if (q && !m.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [menuItems, search, categoryFilter])

  const totals = useMemo(() => {
    let subtotal = 0
    let tax = 0
    for (const line of cart) {
      const unit = priced(line.price)?.unitPrice ?? Number(line.price)
      const lineSubtotal = unit * line.qty
      subtotal += lineSubtotal
      tax += lineSubtotal * (Number(line.taxPercent ?? 0) / 100)
    }
    return { subtotal, tax, total: subtotal + tax }
  }, [cart, priced])

  function addToCart(item: MenuItemOption) {
    setError(null)
    setCart((lines) => {
      const existing = lines.find((l) => l.menuItemId === item.id)
      if (existing) return lines.map((l) => (l.menuItemId === item.id ? { ...l, qty: l.qty + 1 } : l))
      return [
        ...lines,
        { menuItemId: item.id, name: item.name, price: item.price, taxPercent: item.taxPercent, qty: 1, specialInstructions: '' },
      ]
    })
  }

  function updateQty(menuItemId: string, delta: number) {
    setCart((lines) =>
      lines.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: Math.max(1, l.qty + delta) } : l)),
    )
  }

  function updateInstructions(menuItemId: string, value: string) {
    setCart((lines) => lines.map((l) => (l.menuItemId === menuItemId ? { ...l, specialInstructions: value } : l)))
  }

  function removeLine(menuItemId: string) {
    setCart((lines) => lines.filter((l) => l.menuItemId !== menuItemId))
  }

  function submit() {
    setError(null)
    if (cart.length === 0) {
      setError('Add at least one item.')
      return
    }
    start(async () => {
      const r = await createOrder({
        branchId,
        bookingId,
        idempotencyKey,
        items: cart.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          specialInstructions: l.specialInstructions || undefined,
        })),
      })
      if (r.error) setError(r.error)
      else onCreated(r.orderNumber ?? '')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative grid max-h-[92vh] w-full max-w-4xl grid-cols-1 overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl md:grid-cols-[1.2fr_1fr]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full border border-border/60 bg-background/90 p-1.5 text-muted-foreground shadow-sm backdrop-blur-sm transition hover:text-foreground"
        >
          <X size={16} />
        </button>

        {/* Item picker */}
        <div className="order-2 p-6 pt-8 md:order-1">
          <h2 className="text-xl font-semibold">Take order</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {bookingId ? `Attaching to booking ${bookingLabel ?? ''}` : 'Walk-in order — not tied to a booking.'}
          </p>

          {liveRules.length > 0 && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <Zap size={14} />
              Happy hour is on — {liveRules.map((r) => r.name).join(', ')}. Prices below are already discounted.
            </p>
          )}

          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
            <input
              className={`${input} pl-10`}
              placeholder="Search menu items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {categories.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <CategoryChip active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>
                All
              </CategoryChip>
              {categories.map((c) => (
                <CategoryChip key={c.id} active={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id)}>
                  {c.name}
                </CategoryChip>
              ))}
            </div>
          )}

          <div className="mt-3 max-h-[50vh] space-y-1.5 overflow-y-auto pr-1 md:max-h-[60vh]">
            {filteredItems.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No menu items match.
              </p>
            ) : (
              filteredItems.map((item) => {
                const applied = priced(item.price)
                return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addToCart(item)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium">{item.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{item.categoryName}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex flex-col items-end">
                      {applied && (
                        <span className="text-xs text-muted-foreground line-through">
                          {formatMoney(item.price, currency)}
                        </span>
                      )}
                      <span className={`text-base font-semibold ${applied ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                        {formatMoney(applied ? applied.unitPrice : item.price, currency)}
                      </span>
                    </div>
                    <span className="rounded-md bg-primary/10 p-1.5 text-primary">
                      <Plus size={14} />
                    </span>
                  </div>
                </button>
                )
              })
            )}
          </div>
        </div>

        {/* Cart */}
        <div className="order-1 flex flex-col border-b border-border bg-gradient-to-b from-muted/30 to-transparent p-6 pt-8 md:order-2 md:border-b-0 md:border-l">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <ShoppingCart size={14} /> Order ({cart.length})
          </p>

          <div className="mt-3 max-h-[35vh] space-y-2 overflow-y-auto pr-1 md:max-h-[48vh] md:flex-1">
            {cart.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Tap items to add them to the order.
              </p>
            ) : (
              cart.map((line) => {
                const applied = priced(line.price)
                const unit = applied ? applied.unitPrice : Number(line.price)
                return (
                <div key={line.menuItemId} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">{line.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {applied && (
                          <span className="mr-1.5 line-through">{formatMoney(line.price, currency)}</span>
                        )}
                        {formatMoney(unit, currency)} each
                        {applied && (
                          <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                            <Zap size={10} /> {applied.rule.name}
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(line.menuItemId)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${line.name}`}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="inline-flex items-center rounded-md border border-border">
                      <button
                        type="button"
                        onClick={() => updateQty(line.menuItemId, -1)}
                        className="px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground"
                        aria-label={`Decrease quantity of ${line.name}`}
                      >
                        <Minus size={14} />
                      </button>
                      <span className="w-8 text-center text-sm font-medium">{line.qty}</span>
                      <button
                        type="button"
                        onClick={() => updateQty(line.menuItemId, 1)}
                        className="px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground"
                        aria-label={`Increase quantity of ${line.name}`}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <span className="text-base font-semibold">{formatMoney(unit * line.qty, currency)}</span>
                  </div>
                  <input
                    className="mt-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                    placeholder="Special instructions (optional)"
                    value={line.specialInstructions}
                    onChange={(e) => updateInstructions(line.menuItemId, e.target.value)}
                  />
                </div>
                )
              })
            )}
          </div>

          <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatMoney(totals.subtotal, currency)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax</span>
              <span>{formatMoney(totals.tax, currency)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold text-foreground">
              <span>Total</span>
              <span>{formatMoney(totals.total, currency)}</span>
            </div>
          </div>

          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

          <div className="mt-3 flex gap-2">
            <button
              className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
              disabled={pending || cart.length === 0}
              onClick={submit}
            >
              {pending && <Loader2 size={16} className="animate-spin" />}
              {pending ? 'Placing…' : 'Place order'}
            </button>
            <button className={`${btn} border`} disabled={pending} onClick={onClose}>
              Cancel
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Any happy-hour discount is confirmed by the server when the order is placed.
          </p>
        </div>
      </div>
    </div>
  )
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
