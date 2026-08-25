'use client'

import { useEffect, useState, useTransition } from 'react'
import { X, UtensilsCrossed, Minus, Plus, Loader2, CheckCircle2, ShoppingBag, StickyNote } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import { useBodyScrollLock } from '@/lib/hooks/useBodyScrollLock'
import { placeOnlineOrder } from '@/lib/actions/public-orders'
import { useOrderCart } from './OrderCartProvider'
import type { OrderableMenuCategory } from './OrderMenuClient'

const TRANSITION_MS = 300

/**
 * Opened from the navbar's cart button (OrderNavbar) instead of a bottom
 * sticky bar. Mounted only while the cart is open — kept as a wrapper
 * (CartDrawerHost) around the drawer itself so useBodyScrollLock (which
 * locks for as long as it's mounted) only ever runs while the drawer is
 * actually showing.
 */
export function CartDrawerHost({
  stationToken,
  stationName,
  hasActiveBooking,
  currency,
  categories,
}: {
  stationToken: string
  stationName: string
  hasActiveBooking: boolean
  currency: string
  categories: OrderableMenuCategory[]
}) {
  const { cartOpen, cart } = useOrderCart()
  if (!cartOpen) return null

  const hasHappyHourLine = categories.some((c) => c.items.some((i) => i.discountedPrice !== null && cart[i.id]))

  return (
    <CartDrawer
      stationToken={stationToken}
      stationName={stationName}
      hasActiveBooking={hasActiveBooking}
      hasHappyHourLine={hasHappyHourLine}
      currency={currency}
    />
  )
}

/** A right-edge slide-in panel (not a bottom sheet). `visible` starts false
 *  and flips true a frame after mount so the transform transition actually
 *  animates in; closing reverses that transition before telling the
 *  provider to unmount, so it slides back out instead of vanishing. */
function CartDrawer({
  stationToken,
  stationName,
  hasActiveBooking,
  hasHappyHourLine,
  currency,
}: {
  stationToken: string
  stationName: string
  hasActiveBooking: boolean
  hasHappyHourLine: boolean
  currency: string
}) {
  const { cartLines, cartCount, cartTotal, closeCart, incrementById, decrementById, removeLine, updateNote, clearCart } =
    useOrderCart()
  useBodyScrollLock()
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placedOrderNumber, setPlacedOrderNumber] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleClose() {
    setVisible(false)
    window.setTimeout(closeCart, TRANSITION_MS)
  }

  function handlePlaceOrder() {
    setError(null)
    startTransition(async () => {
      const res = await placeOnlineOrder({
        stationToken,
        items: cartLines.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          specialInstructions: l.specialInstructions.trim() || undefined,
        })),
      })
      if (res.error) {
        setError(res.error)
        return
      }
      setPlacedOrderNumber(res.orderNumber ?? null)
      clearCart()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={handleClose}
      />
      <div
        className={`relative z-10 flex h-[100dvh] w-full flex-col border-l border-border/60 bg-card shadow-2xl transition-transform duration-300 ease-out sm:max-w-md ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-gradient-to-r from-primary/5 via-transparent to-transparent px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-violet-500 text-primary-foreground shadow-lg shadow-primary/20">
              <ShoppingBag size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-black tracking-tight text-foreground">
                {placedOrderNumber ? 'Order placed' : 'Your order'}
              </h2>
              {!placedOrderNumber && (
                <p className="truncate text-xs font-medium text-muted-foreground">
                  {cartCount > 0 ? `${cartCount} item${cartCount === 1 ? '' : 's'} · ${stationName}` : stationName}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
            aria-label="Close cart"
          >
            <X size={18} />
          </button>
        </div>

        {placedOrderNumber ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="size-9 text-emerald-500" />
            </span>
            <p className="text-lg font-black tracking-tight">Order #{placedOrderNumber} sent to the kitchen!</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              {hasActiveBooking ? 'This has been added to your current booking.' : "We'll bring it out to you shortly."}
            </p>
            <button
              type="button"
              onClick={handleClose}
              className="mt-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary-hover active:scale-95"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {hasActiveBooking && (
                <p className="mb-4 rounded-xl bg-primary/5 px-3.5 py-2.5 text-xs font-medium text-primary">
                  This order will be linked to your current booking at {stationName}.
                </p>
              )}
              {cartLines.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                  <span className="flex size-14 items-center justify-center rounded-2xl bg-muted">
                    <ShoppingBag className="size-6 text-muted-foreground/50" />
                  </span>
                  <p className="text-sm font-semibold text-foreground">Your cart is empty</p>
                  <p className="max-w-[220px] text-xs text-muted-foreground">Add items from the menu to start your order.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {cartLines.map((line) => (
                    <div
                      key={line.menuItemId}
                      className="group flex gap-3 rounded-2xl border border-border/60 bg-background/60 p-3 shadow-sm transition-colors hover:border-primary/25"
                    >
                      {line.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={line.imageUrl} alt={line.name} className="size-16 shrink-0 rounded-xl object-cover" />
                      ) : (
                        <div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-muted">
                          <UtensilsCrossed className="size-5 text-muted-foreground/40" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-bold leading-tight text-foreground">{line.name}</p>
                          <button
                            type="button"
                            onClick={() => removeLine(line.menuItemId)}
                            className="shrink-0 rounded-md p-0.5 text-muted-foreground/70 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Remove"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <label className="mt-2 flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2 py-1.5 text-xs focus-within:border-primary">
                          <StickyNote size={12} className="shrink-0 text-muted-foreground/60" />
                          <input
                            type="text"
                            placeholder="Add a note (optional)"
                            value={line.specialInstructions}
                            onChange={(e) => updateNote(line.menuItemId, e.target.value)}
                            className="w-full bg-transparent outline-none placeholder:text-muted-foreground/60"
                          />
                        </label>
                        <div className="mt-2.5 flex items-center justify-between">
                          <div className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-1">
                            <button
                              type="button"
                              onClick={() => decrementById(line.menuItemId)}
                              aria-label="Remove one"
                              className="flex size-6 items-center justify-center rounded-full bg-background text-foreground shadow-sm active:scale-90"
                            >
                              <Minus size={12} />
                            </button>
                            <span className="min-w-4 text-center text-sm font-bold">{line.qty}</span>
                            <button
                              type="button"
                              onClick={() => incrementById(line.menuItemId)}
                              aria-label="Add one more"
                              className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm active:scale-90"
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                          <span className="text-sm font-bold text-primary">{formatMoney(line.unitPrice * line.qty, currency)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {cartLines.length > 0 && (
              <div className="border-t border-border/70 bg-card px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
                {hasHappyHourLine && (
                  <p className="mb-2 text-xs text-muted-foreground">Prices already include the active happy-hour discount.</p>
                )}
                {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
                <div className="mb-3 flex items-center justify-between text-base font-black">
                  <span>Total</span>
                  <span className="text-primary">{formatMoney(cartTotal, currency)}</span>
                </div>
                <button
                  type="button"
                  onClick={handlePlaceOrder}
                  disabled={pending}
                  className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />
                  {pending && <Loader2 size={16} className="animate-spin" />}
                  {pending ? 'Placing order...' : 'Place order'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
