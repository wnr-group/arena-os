'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Plus, Minus, X, Search, Loader2, ShoppingCart, Zap, PackageCheck, PackageX } from 'lucide-react'
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
  /** Cart identity — menuItemId plus the sorted chosen option ids plus the
   *  seat it was added for, so "burger, no onions", "burger, extra cheese"
   *  and "burger for seat 2" all stay separate lines instead of merging into
   *  one qty. See cartLineKey below. */
  key: string
  menuItemId: string
  name: string
  price: string
  taxPercent: string | null
  qty: number
  specialInstructions: string
  modifiers: CartModifier[]
  /** Seat/guest tag (M18 #1) — null means unassigned/shared. Set from
   *  whichever seat was active when the line was added; bookkeeping only,
   *  never affects price. */
  seatNo: number | null
}

function cartLineKey(menuItemId: string, optionIds: string[], seatNo: number | null): string {
  return [menuItemId, ...[...optionIds].sort(), seatNo ?? 'shared'].join('::')
}

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const btn = 'rounded-lg px-3.5 py-2.5 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50'

/** Modal for taking a food/drink order against a booking — menu picker, quantities, optional seat tagging. */
export function TakeOrderDialog({
  branchId,
  bookingId,
  bookingLabel,
  currency,
  categories,
  menuItems,
  happyHours,
  timeZone,
  canToggle86,
  seatCount,
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
  /** Top-ordered item ids for the branch (lib/menu/data.ts::listMostOrderedItemIds).
   *  Accepted for compatibility with existing callers but no longer rendered —
   *  the "Popular" quick-add row was removed from this screen. */
  popularItemIds?: string[]
  /** Shows the inline 86/un-86 toggle on each item — a UI nicety only;
   *  setMenuItemAvailability re-checks canManageKitchen() server-side
   *  regardless (M17 #7). */
  canToggle86?: boolean
  /** The table session's guest count (bookings.cover_count, M17 #1) — shows
   *  a "Seat 1 / Seat 2 / … / Shared" picker (M18 #1) so a waiter can tag
   *  each item to a guest for later by-seat bill splitting. Omitted (or < 2)
   *  hides the picker entirely: every non-restaurant caller of this dialog
   *  passes nothing, so seat tagging never appears outside a table session. */
  seatCount?: number | null
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
  // Which seat newly-added items are tagged with (M18 #1) — null = shared.
  // Tap a seat chip, then tap items as usual; nothing here blocks ordering
  // when it's left at "Shared" (the default), so tagging stays fully optional.
  const [activeSeat, setActiveSeat] = useState<number | null>(null)
  const showSeatPicker = Boolean(seatCount && seatCount >= 2)
  // Below lg, the cart lives in a bottom sheet (toggled from the summary bar)
  // instead of a permanent third column — there just isn't room for three
  // panels side by side until the viewport is wide enough.
  const [mobileCartOpen, setMobileCartOpen] = useState(false)

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
    const key = cartLineKey(item.id, [], activeSeat)
    setCart((lines) => {
      const existing = lines.find((l) => l.key === key)
      if (existing) return lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l))
      return [
        ...lines,
        { key, menuItemId: item.id, name: item.name, price: item.price, taxPercent: item.taxPercent, qty: 1, specialInstructions: '', modifiers: [], seatNo: activeSeat },
      ]
    })
  }

  function addToCartWithModifiers(item: MenuItemOption, modifiers: CartModifier[]) {
    setError(null)
    const key = cartLineKey(item.id, modifiers.map((m) => m.optionId), activeSeat)
    setCart((lines) => {
      const existing = lines.find((l) => l.key === key)
      if (existing) return lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l))
      return [
        ...lines,
        { key, menuItemId: item.id, name: item.name, price: item.price, taxPercent: item.taxPercent, qty: 1, specialInstructions: '', modifiers, seatNo: activeSeat },
      ]
    })
  }

  // Decrementing to 0 removes the line — previously this floored at 1 via
  // Math.max(1, ...), which silently ate every tap on "-" once qty reached 1
  // (the reported bug: decreasing "worked" only down to 1, then did nothing).
  function updateQty(key: string, delta: number) {
    setCart((lines) =>
      lines.flatMap((l) => {
        if (l.key !== key) return [l]
        const nextQty = l.qty + delta
        return nextQty <= 0 ? [] : [{ ...l, qty: nextQty }]
      }),
    )
  }

  /** Total quantity of a menu item across every cart line (any modifiers/seat) — a
   *  quick-glance badge on the item grid so a waiter can see what's already ordered
   *  without switching to the cart. */
  function cartQtyForItem(menuItemId: string): number {
    return cart.filter((l) => l.menuItemId === menuItemId).reduce((sum, l) => sum + l.qty, 0)
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
          seatNo: l.seatNo ?? undefined,
        })),
      })
      if (r.error) setError(r.error)
      else onCreated(r.orderNumber ?? '')
    })
  }

  /** Shared between the permanent desktop column and the mobile bottom sheet
   *  — same cart, same handlers, just mounted in whichever container fits
   *  the current breakpoint (see the two usages below). */
  const cartContent = (
    <>
      <div className="hidden shrink-0 items-center justify-between px-4 pt-4 lg:flex xl:px-5">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <ShoppingCart size={14} /> Order ({cart.length})
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 xl:px-5">
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
                    <p className="truncate text-base font-medium">
                      {line.name}
                      {line.seatNo !== null && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                          Seat {line.seatNo}
                        </span>
                      )}
                    </p>
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

      <div className="shrink-0 border-t border-border p-4 xl:px-5">
        <div className="space-y-1 text-sm">
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
      </div>
    </>
  )

  const totalQty = cart.reduce((n, l) => n + l.qty, 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-6"
      onClick={onClose}
    >
      <div
        className="relative flex h-full w-full flex-col overflow-hidden bg-card shadow-2xl lg:h-[92vh] lg:max-w-[1360px] lg:rounded-2xl lg:border lg:border-border"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Take order"
      >
        {/* Header — title, seat picker, search, and (below lg) category chips */}
        <div className="shrink-0 border-b border-border bg-card/95 px-4 py-3 backdrop-blur-sm sm:px-6 sm:py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold sm:text-xl">Take order</h2>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {bookingId ? `Attaching to booking ${bookingLabel ?? ''}` : 'Walk-in order — not tied to a booking.'}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-full border border-border/60 bg-background/90 p-2 text-muted-foreground shadow-sm transition hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>

          {showSeatPicker && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Ordering for
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <CategoryChip active={activeSeat === null} onClick={() => setActiveSeat(null)}>
                  Shared
                </CategoryChip>
                {Array.from({ length: seatCount! }, (_, i) => i + 1).map((seat) => (
                  <CategoryChip key={seat} active={activeSeat === seat} onClick={() => setActiveSeat(seat)}>
                    Seat {seat}
                  </CategoryChip>
                ))}
              </div>
            </div>
          )}

          {liveRules.length > 0 && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <Zap size={14} />
              Happy hour is on — {liveRules.map((r) => r.name).join(', ')}. Prices below are already discounted.
            </p>
          )}

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} />
            <input
              className={`${input} pl-10`}
              placeholder="Search menu items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Below lg, categories live here as scrollable chips; at lg+ they move
              into the sidebar instead, which is what keeps a long category list
              from turning into a wall of wrapped chips. */}
          {categories.length > 0 && (
            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5 lg:hidden">
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
        </div>

        {/* Body: category sidebar (lg+) | item grid | cart column (lg+) */}
        <div className="flex min-h-0 flex-1">
          {categories.length > 0 && (
            <div className="hidden w-48 shrink-0 overflow-y-auto border-r border-border p-3 lg:block xl:w-56">
              <SidebarCategoryButton active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>
                All items
              </SidebarCategoryButton>
              {categories.map((c) => (
                <SidebarCategoryButton key={c.id} active={categoryFilter === c.id} onClick={() => setCategoryFilter(c.id)}>
                  {c.name}
                </SidebarCategoryButton>
              ))}
            </div>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {filteredItems.length === 0 ? (
              <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                No menu items match.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {filteredItems.map((item) => {
                  const applied = priced(item.price)
                  const outOfStock = item.status === 'out_of_stock'
                  const isToggling = togglingId === item.id
                  const hasModifiers = Boolean(item.modifierGroups && item.modifierGroups.length > 0)
                  const qtyInCart = cartQtyForItem(item.id)
                  return (
                    <div key={item.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => handleTap(item)}
                        disabled={outOfStock}
                        className="flex h-full w-full flex-col justify-between gap-3 rounded-xl border border-border bg-card p-3.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-border disabled:hover:shadow-sm"
                      >
                        <div>
                          <p className="text-sm font-semibold leading-snug">{item.name}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.categoryName}</p>
                          {(outOfStock || hasModifiers) && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {outOfStock && (
                                <span className="inline-flex items-center rounded-full bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                                  86&apos;d
                                </span>
                              )}
                              {!outOfStock && hasModifiers && (
                                <span className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                  Customizable
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-end justify-between gap-2">
                          <div className="flex flex-col">
                            {applied && (
                              <span className="text-xs text-muted-foreground line-through">
                                {formatMoney(item.price, currency)}
                              </span>
                            )}
                            <span className={`text-sm font-semibold ${applied ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                              {formatMoney(applied ? applied.unitPrice : item.price, currency)}
                            </span>
                          </div>
                          {!outOfStock && (
                            <span className="shrink-0 rounded-lg bg-primary/10 p-1.5 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
                              <Plus size={14} />
                            </span>
                          )}
                        </div>
                      </button>
                      {qtyInCart > 0 && (
                        <span className="pointer-events-none absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground shadow">
                          {qtyInCart}
                        </span>
                      )}
                      {canToggle86 && (
                        <button
                          type="button"
                          onClick={() => toggle86(item)}
                          disabled={isToggling}
                          title={outOfStock ? 'Un-86 — mark available' : '86 — mark out of stock'}
                          aria-label={outOfStock ? 'Un-86 — mark available' : '86 — mark out of stock'}
                          className={`absolute -left-1.5 -top-1.5 rounded-full border border-border bg-card p-1 shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            outOfStock ? 'text-emerald-600 hover:bg-emerald-500/10' : 'text-amber-600 hover:bg-amber-500/10'
                          }`}
                        >
                          {isToggling ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : outOfStock ? (
                            <PackageCheck size={12} />
                          ) : (
                            <PackageX size={12} />
                          )}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="hidden w-[380px] shrink-0 flex-col border-l border-border bg-gradient-to-b from-muted/30 to-transparent lg:flex">
            {cartContent}
          </div>
        </div>

        {/* Below lg the cart isn't a permanent column — this bar surfaces it as
            a bottom sheet instead, so it never has to compete for space with
            a long menu. */}
        {cart.length > 0 && (
          <button
            type="button"
            onClick={() => setMobileCartOpen(true)}
            className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-primary px-4 py-3 text-primary-foreground shadow-[0_-4px_12px_rgba(0,0,0,0.12)] lg:hidden"
          >
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <ShoppingCart size={16} />
              {totalQty} item{totalQty === 1 ? '' : 's'}
            </span>
            <span className="text-sm font-bold">View order · {formatMoney(totals.total, currency)}</span>
          </button>
        )}
      </div>

      {mobileCartOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-end bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileCartOpen(false)}
        >
          <div
            className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border/60 bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border p-4">
              <h3 className="text-base font-semibold">Your order</h3>
              <button
                type="button"
                onClick={() => setMobileCartOpen(false)}
                aria-label="Close cart"
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>
            {cartContent}
          </div>
        </div>
      )}

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
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
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

/** The lg+ sidebar's category row — a vertical list scales to any number of
 *  categories without wrapping into a multi-line wall of chips the way the
 *  mobile CategoryChip row would. */
function SidebarCategoryButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`mb-1 block w-full truncate rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
