'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Plus, Minus, X, Search, Loader2, ShoppingCart, Zap, Flame, PackageCheck, PackageX } from 'lucide-react'
import { createOrder } from '@/lib/actions/orders'
import { setMenuItemAvailability } from '@/lib/actions/menu'
import { formatMoney } from '@/lib/format'
import { applyHappyHour, activeHappyHours, type HappyHourRule } from '@/lib/happy-hours/apply'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'

export type CategoryOption = { id: string; name: string }
export type ModifierOptionChoice = { id: string; name: string; priceDelta: string }
export type ItemModifierGroup = {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  required: boolean
  options: ModifierOptionChoice[]
}
export type MenuItemOption = {
  id: string
  name: string
  price: string
  categoryId: string
  categoryName: string
  taxPercent: string | null
  /** 'hidden' items should never be included by the caller — this is only
   *  ever 'available' or 'out_of_stock' in practice, but typed loosely so an
   *  unexpected value fails safe (disabled) rather than orderable. */
  status?: string
  /** Structured choices this item offers (M17 #8) — a size, add-ons, "no
   *  onions." Empty/omitted for an item with no modifiers, which keeps the
   *  original one-tap add-to-cart behaviour untouched. */
  modifierGroups?: ItemModifierGroup[]
}
type CartModifier = { groupName: string; optionId: string; optionName: string; priceDelta: string }
type CartLine = {
  /** Cart identity — menuItemId alone for an unmodified line, or menuItemId
   *  plus the sorted chosen option ids for a modified one, so "burger, no
   *  onions" and "burger, extra cheese" stay separate lines instead of
   *  merging into one qty. See cartLineKey below. */
  key: string
  menuItemId: string
  name: string
  price: string
  taxPercent: string | null
  qty: number
  specialInstructions: string
  modifiers: CartModifier[]
}

function cartLineKey(menuItemId: string, optionIds: string[]): string {
  return [menuItemId, ...[...optionIds].sort()].join('::')
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
  popularItemIds,
  canToggle86,
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
  /** Top-ordered item ids for the branch (lib/menu/data.ts::listMostOrderedItemIds)
   *  — rendered as a quick-tap "Popular" row so a waiter can fire the usual
   *  round without searching. Optional: omit for callers with no order history yet. */
  popularItemIds?: string[]
  /** Shows the inline 86/un-86 toggle on each item — a UI nicety only;
   *  setMenuItemAvailability re-checks canManageKitchen() server-side
   *  regardless (M17 #7). */
  canToggle86?: boolean
  onClose: () => void
  onCreated: (orderNumber: string) => void
}) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [cart, setCart] = useState<CartLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  // Local copy so an 86/un-86 toggle updates this dialog immediately without
  // losing the cart the way a full page refresh would — see toggle86 below.
  const [items, setItems] = useState(menuItems)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  // Set only while the modifier picker is open for an item that has groups —
  // addToCart is called directly for anything without them.
  const [pickerItem, setPickerItem] = useState<MenuItemOption | null>(null)

  function handleTap(item: MenuItemOption) {
    if (item.status && item.status !== 'available') return
    if (item.modifierGroups && item.modifierGroups.length > 0) {
      setPickerItem(item)
    } else {
      addToCart(item)
    }
  }

  // Deliberately NOT wrapped in the shared `start`/`pending` transition above
  // — that pair also drives the "Place order" button's disabled/"Placing…"
  // state, and toggling an item's stock has nothing to do with submitting
  // the order. togglingId already tracks this row's own pending state.
  async function toggle86(item: MenuItemOption) {
    const next = item.status === 'out_of_stock' ? 'available' : 'out_of_stock'
    setTogglingId(item.id)
    setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, status: next } : m)))
    const r = await setMenuItemAvailability({ id: item.id, status: next })
    if (r.error) {
      // Revert — the server refused, so the optimistic flip was wrong.
      setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, status: item.status } : m)))
      setError(r.error)
    }
    setTogglingId(null)
  }

  // Idempotency (migration 0065) — stable for as long as this dialog stays
  // open, so a network retry or an impatient double-tap on "Place order"
  // never cooks the food twice. The dialog unmounts on success (onCreated
  // closes it), so a fresh key for the next order comes for free on remount.
  const [idempotencyKey] = useState(() => newIdempotencyKey())

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
    return items.filter((m) => {
      if (categoryFilter !== 'all' && m.categoryId !== categoryFilter) return false
      if (q && !m.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, categoryFilter])

  // Only shown on the unfiltered default view — once a waiter is searching
  // or has picked a category, the popular row would just be noise above the
  // list they already narrowed down.
  const popularItems = useMemo(() => {
    if (!popularItemIds || search.trim() || categoryFilter !== 'all') return []
    const byId = new Map(items.map((m) => [m.id, m]))
    return popularItemIds.map((id) => byId.get(id)).filter((m): m is MenuItemOption => Boolean(m))
  }, [popularItemIds, items, search, categoryFilter])

  /** A line's per-unit price including every chosen modifier's delta — happy
   *  hour only ever discounts the base item, never an add-on. */
  function lineUnitPrice(line: CartLine): number {
    const base = priced(line.price)?.unitPrice ?? Number(line.price)
    const deltaSum = line.modifiers.reduce((sum, m) => sum + Number(m.priceDelta), 0)
    return base + deltaSum
  }

  const totals = useMemo(() => {
    let subtotal = 0
    let tax = 0
    for (const line of cart) {
      const lineSubtotal = lineUnitPrice(line) * line.qty
      subtotal += lineSubtotal
      tax += lineSubtotal * (Number(line.taxPercent ?? 0) / 100)
    }
    return { subtotal, tax, total: subtotal + tax }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, priced])

  /** The fast path for an item with no modifier groups — unchanged one-tap
   *  add/increment. An item WITH groups instead opens the picker (see
   *  pickerItem below) and always goes through addToCartWithModifiers,
   *  even for a repeat add, since which existing line (if any) to increment
   *  depends on which options are chosen this time. */
  function addToCart(item: MenuItemOption) {
    if (item.status && item.status !== 'available') return
    setError(null)
    const key = cartLineKey(item.id, [])
    setCart((lines) => {
      const existing = lines.find((l) => l.key === key)
      if (existing) return lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l))
      return [
        ...lines,
        { key, menuItemId: item.id, name: item.name, price: item.price, taxPercent: item.taxPercent, qty: 1, specialInstructions: '', modifiers: [] },
      ]
    })
  }

  function addToCartWithModifiers(item: MenuItemOption, modifiers: CartModifier[]) {
    setError(null)
    const key = cartLineKey(item.id, modifiers.map((m) => m.optionId))
    setCart((lines) => {
      const existing = lines.find((l) => l.key === key)
      if (existing) return lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l))
      return [
        ...lines,
        { key, menuItemId: item.id, name: item.name, price: item.price, taxPercent: item.taxPercent, qty: 1, specialInstructions: '', modifiers },
      ]
    })
  }

  function updateQty(key: string, delta: number) {
    setCart((lines) => lines.map((l) => (l.key === key ? { ...l, qty: Math.max(1, l.qty + delta) } : l)))
  }

  function updateInstructions(key: string, value: string) {
    setCart((lines) => lines.map((l) => (l.key === key ? { ...l, specialInstructions: value } : l)))
  }

  function removeLine(key: string) {
    setCart((lines) => lines.filter((l) => l.key !== key))
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
          modifierOptionIds: l.modifiers.map((m) => m.optionId),
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

          {popularItems.length > 0 && (
            <div className="mt-4">
              <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Flame size={13} /> Popular
              </p>
              <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
                {popularItems.map((item) => {
                  const outOfStock = item.status === 'out_of_stock'
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleTap(item)}
                      disabled={outOfStock}
                      title={outOfStock ? '86\'d — currently out of stock' : undefined}
                      className="shrink-0 whitespace-nowrap rounded-full border border-border px-3 py-1.5 text-sm font-medium transition hover:border-primary/50 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent"
                    >
                      {item.name}
                    </button>
                  )
                })}
              </div>
            </div>
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
                const outOfStock = item.status === 'out_of_stock'
                const isToggling = togglingId === item.id
                const hasModifiers = Boolean(item.modifierGroups && item.modifierGroups.length > 0)
                return (
                <div key={item.id} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleTap(item)}
                    disabled={outOfStock}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">
                        {item.name}
                        {outOfStock && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                            86&apos;d
                          </span>
                        )}
                        {!outOfStock && hasModifiers && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                            Customizable
                          </span>
                        )}
                      </p>
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
                      {!outOfStock && (
                        <span className="rounded-md bg-primary/10 p-1.5 text-primary">
                          <Plus size={14} />
                        </span>
                      )}
                    </div>
                  </button>
                  {canToggle86 && (
                    <button
                      type="button"
                      onClick={() => toggle86(item)}
                      disabled={isToggling}
                      title={outOfStock ? 'Un-86 — mark available' : '86 — mark out of stock'}
                      aria-label={outOfStock ? 'Un-86 — mark available' : '86 — mark out of stock'}
                      className={`shrink-0 rounded-lg border border-border p-2.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        outOfStock ? 'text-emerald-600 hover:bg-emerald-500/10' : 'text-amber-600 hover:bg-amber-500/10'
                      }`}
                    >
                      {isToggling ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : outOfStock ? (
                        <PackageCheck size={15} />
                      ) : (
                        <PackageX size={15} />
                      )}
                    </button>
                  )}
                </div>
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
                const unit = lineUnitPrice(line)
                return (
                <div key={line.key} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">{line.name}</p>
                      {line.modifiers.length > 0 && (
                        <p className="truncate text-sm text-muted-foreground">
                          {line.modifiers.map((m) => m.optionName).join(', ')}
                        </p>
                      )}
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
                      onClick={() => removeLine(line.key)}
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
                        onClick={() => updateQty(line.key, -1)}
                        className="px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground"
                        aria-label={`Decrease quantity of ${line.name}`}
                      >
                        <Minus size={14} />
                      </button>
                      <span className="w-8 text-center text-sm font-medium">{line.qty}</span>
                      <button
                        type="button"
                        onClick={() => updateQty(line.key, 1)}
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
                    onChange={(e) => updateInstructions(line.key, e.target.value)}
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

      {pickerItem && (
        <ModifierPickerDialog
          item={pickerItem}
          currency={currency}
          onClose={() => setPickerItem(null)}
          onConfirm={(modifiers) => {
            addToCartWithModifiers(pickerItem, modifiers)
            setPickerItem(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Prompts for an item's modifier choices before it can be added to the cart
 * (M17 #8) — opened by handleTap whenever an item has at least one group.
 * Client-side min/max enforcement is a UX nicety only: createOrderCore
 * re-validates every group's min/max against the same DB rows when the
 * order is actually placed, so a stale picker (a group edited after this
 * dialog opened) can never smuggle through an invalid selection.
 */
function ModifierPickerDialog({
  item,
  currency,
  onClose,
  onConfirm,
}: {
  item: MenuItemOption
  currency: string
  onClose: () => void
  onConfirm: (modifiers: CartModifier[]) => void
}) {
  const groups = item.modifierGroups ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  function toggleOption(group: ItemModifierGroup, optionId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? []
      if (current.includes(optionId)) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) }
      }
      if (group.maxSelect === 1) {
        // Single-select: picking a new option always replaces the old one.
        return { ...prev, [group.id]: [optionId] }
      }
      if (current.length >= group.maxSelect) return prev
      return { ...prev, [group.id]: [...current, optionId] }
    })
  }

  const errors = groups
    .filter((g) => (selected[g.id]?.length ?? 0) < g.minSelect)
    .map((g) => `Choose ${g.minSelect === g.maxSelect ? '' : 'at least '}${g.minSelect} for "${g.name}."`)
  const isValid = errors.length === 0

  function confirm() {
    setSubmitted(true)
    if (!isValid) return
    const modifiers: CartModifier[] = groups.flatMap((g) =>
      (selected[g.id] ?? []).map((optionId) => {
        const opt = g.options.find((o) => o.id === optionId)!
        return { groupName: g.name, optionId, optionName: opt.name, priceDelta: opt.priceDelta }
      }),
    )
    onConfirm(modifiers)
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-base font-semibold">{item.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {groups.map((group) => (
            <div key={group.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{group.name}</p>
                <span className="text-xs text-muted-foreground">
                  {group.minSelect === group.maxSelect
                    ? `Choose ${group.minSelect}`
                    : group.minSelect === 0
                      ? `Choose up to ${group.maxSelect}`
                      : `Choose ${group.minSelect}–${group.maxSelect}`}
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                {group.options.map((opt) => {
                  const active = (selected[group.id] ?? []).includes(opt.id)
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => toggleOption(group, opt.id)}
                      aria-pressed={active}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                        active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted/40'
                      }`}
                    >
                      <span className="font-medium">{opt.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {Number(opt.priceDelta) === 0 ? 'No charge' : `+${formatMoney(opt.priceDelta, currency)}`}
                      </span>
                    </button>
                  )
                })}
              </div>
              {submitted && (selected[group.id]?.length ?? 0) < group.minSelect && (
                <p className="mt-1.5 text-xs text-destructive">
                  Choose {group.minSelect === group.maxSelect ? '' : 'at least '}
                  {group.minSelect} option{group.minSelect === 1 ? '' : 's'}.
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-2 border-t border-border p-4">
          <button
            type="button"
            className="flex-1 rounded-lg border border-border px-3.5 py-2.5 text-sm font-medium transition hover:bg-muted"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${btn} flex flex-1 items-center justify-center gap-2 bg-primary text-primary-foreground shadow-sm hover:shadow-md`}
            onClick={confirm}
          >
            Add to order
          </button>
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
