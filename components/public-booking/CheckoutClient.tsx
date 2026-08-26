'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, ShoppingBag, UtensilsCrossed, Minus, Plus, X, StickyNote, Loader2, MapPin, Flame, Truck } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import { placeOnlineOrder } from '@/lib/actions/public-orders'
import { useOrderCart } from './OrderCartProvider'

/**
 * The standalone checkout screen (replaces the old slide-in CartDrawer) —
 * reviewing and placing an order gets a full page: a left column of editable
 * line items and a right-hand order-summary card that stays in view while
 * scrolling. `station` (table vs. pickup) comes from OrderCartProvider, not
 * a prop, since this page is reached from wherever the cart was built.
 */
export function CheckoutClient({ currency }: { currency: string }) {
  const router = useRouter()
  const { cartLines, cartCount, cartTotal, station, incrementById, decrementById, removeLine, updateNote, clearCart } =
    useOrderCart()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const hasHappyHourLine = cartLines.some((l) => l.hasDiscount)

  function handlePlaceOrder() {
    setError(null)
    startTransition(async () => {
      const res = await placeOnlineOrder({
        stationToken: station?.token,
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
      clearCart()
      toast.success(
        res.pendingAcceptance ? `Order #${res.orderNumber} received!` : `Order #${res.orderNumber} sent to the kitchen!`,
        {
          description: res.pendingAcceptance
            ? "The venue is confirming your order — we'll notify you shortly."
            : station?.hasActiveBooking
              ? 'This has been added to your current booking.'
              : station
                ? "We'll bring it out to you shortly."
                : "We'll have it ready for pickup shortly.",
        },
      )
      router.push('/')
    })
  }

  if (cartLines.length === 0) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-muted">
          <ShoppingBag className="size-7 text-muted-foreground/50" />
        </span>
        <h1 className="text-2xl font-black tracking-tight text-foreground">Your cart is empty</h1>
        <p className="text-sm text-muted-foreground">Add something delicious from the menu to get started.</p>
        <button
          type="button"
          onClick={() => router.push('/food-menu')}
          className="mt-2 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary-hover active:scale-95"
        >
          Browse the menu
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Header */}
      <div className="mb-8">
        <button
          type="button"
          onClick={() => router.back()}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Checkout</h1>
            <p className="mt-1.5 text-sm font-medium text-muted-foreground">
              {cartCount} item{cartCount === 1 ? '' : 's'} · {station ? station.name : 'Pickup order'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-primary">
            {station ? (
              <>
                <MapPin size={12} /> {station.name}
              </>
            ) : (
              <>
                <Truck size={12} /> Pickup order
              </>
            )}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_400px]">
        {/* Items */}
        <div className="space-y-4">
          {station?.hasActiveBooking && (
            <p className="rounded-xl bg-primary/5 px-4 py-3 text-sm font-medium text-primary">
              This order will be linked to your current booking at {station.name}.
            </p>
          )}
          {cartLines.map((line) => (
            <div
              key={line.menuItemId}
              className="group flex gap-4 rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-colors hover:border-primary/25 sm:p-5"
            >
              {line.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={line.imageUrl}
                  alt={line.name}
                  className="size-20 shrink-0 rounded-xl object-cover sm:size-24"
                />
              ) : (
                <div className="flex size-20 shrink-0 items-center justify-center rounded-xl bg-muted sm:size-24">
                  <UtensilsCrossed className="size-6 text-muted-foreground/40" />
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold leading-tight text-foreground">{line.name}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{formatMoney(line.unitPrice, currency)} each</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(line.menuItemId)}
                    className="shrink-0 rounded-lg p-1.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${line.name}`}
                  >
                    <X size={16} />
                  </button>
                </div>

                <label className="mt-3 flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-2 text-sm focus-within:border-primary">
                  <StickyNote size={13} className="shrink-0 text-muted-foreground/60" />
                  <input
                    type="text"
                    placeholder="Add a note (optional)"
                    value={line.specialInstructions}
                    onChange={(e) => updateNote(line.menuItemId, e.target.value)}
                    className="w-full bg-transparent outline-none placeholder:text-muted-foreground/60"
                  />
                </label>

                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center gap-2.5 rounded-full border border-primary/30 bg-primary/5 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => decrementById(line.menuItemId)}
                      aria-label="Remove one"
                      className="flex size-7 items-center justify-center rounded-full bg-background text-foreground shadow-sm active:scale-90"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="min-w-5 text-center text-sm font-bold">{line.qty}</span>
                    <button
                      type="button"
                      onClick={() => incrementById(line.menuItemId)}
                      aria-label="Add one more"
                      className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm active:scale-90"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <span className="text-base font-black text-primary">
                    {formatMoney(line.unitPrice * line.qty, currency)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg shadow-black/[0.03]">
            <div className="bg-gradient-to-r from-primary/5 via-transparent to-transparent px-5 py-4">
              <h2 className="text-base font-black tracking-tight text-foreground">Order summary</h2>
            </div>

            <div className="space-y-3 px-5 py-4">
              {cartLines.map((line) => (
                <div key={line.menuItemId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {line.qty} × {line.name}
                  </span>
                  <span className="shrink-0 font-semibold text-foreground">
                    {formatMoney(line.unitPrice * line.qty, currency)}
                  </span>
                </div>
              ))}
            </div>

            {hasHappyHourLine && (
              <div className="mx-5 mb-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                <Flame size={12} /> Prices already include the active happy-hour discount.
              </div>
            )}

            <div className="border-t border-border/70 px-5 py-4">
              <div className="flex items-center justify-between text-lg font-black">
                <span>Total</span>
                <span className="text-primary">{formatMoney(cartTotal, currency)}</span>
              </div>
            </div>

            <div className="px-5 pb-5">
              {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
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
              <p className="mt-3 text-center text-[11px] font-medium text-muted-foreground/70">
                Sent directly to the venue the moment you place it
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
