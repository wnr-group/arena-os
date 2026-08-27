'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ShoppingBag,
  UtensilsCrossed,
  Minus,
  Plus,
  X,
  StickyNote,
  Loader2,
  MapPin,
  Flame,
  Truck,
  Ticket,
  Phone,
  User,
  Mail,
  CreditCard,
  Wallet,
} from 'lucide-react'
import { formatMoney } from '@/lib/format'
import { placeOnlineOrder, createOrderPaymentIntent, checkBookingStillActive } from '@/lib/actions/public-orders'
import { lookupPublicCustomerByPhone } from '@/lib/actions/public-booking'
import { isValidPhone } from '@/lib/customers/phone'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'
import { MAX_ORDER_ITEM_QTY } from '@/lib/orders/limits'
import { loadCheckoutScript, type RazorpayCtor } from '@/lib/payments/checkout-script'
import { useOrderCart } from './OrderCartProvider'
import { HoneypotField } from './HoneypotField'

/**
 * The standalone checkout screen (replaces the old slide-in CartDrawer) —
 * reviewing and placing an order gets a full page: a left column of editable
 * line items and a right-hand rail (contact details + order summary) that
 * stays in view while scrolling. `station` (table vs. pickup) comes from
 * OrderCartProvider, not a prop, since this page is reached from wherever
 * the cart was built.
 *
 * `razorpayConfigured` (M14 #6, v2) gates the "Pay online now" choice — read
 * server-side (app/(public)/checkout/page.tsx) from the same credential
 * loader that actually calls the gateway, so the button is hidden rather
 * than offered and then failing.
 */
export function CheckoutClient({
  currency,
  venueName,
  razorpayConfigured,
}: {
  currency: string
  venueName: string
  razorpayConfigured: boolean
}) {
  const router = useRouter()
  const {
    cartLines,
    cartCount,
    cartTotal,
    station,
    booking,
    incrementById,
    decrementById,
    removeLine,
    updateNote,
    clearCart,
    clearBooking,
  } = useOrderCart()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // The cached booking attachment can be stale — the customer may have sat
  // on /food-menu or this page long after staff completed/cancelled the
  // booking the nudge link pointed at. Re-check on arrival so the page never
  // confidently promises "this will be added to booking #X" for a booking
  // that can no longer accept orders (createOrderCore would reject it).
  useEffect(() => {
    if (!booking) return
    let cancelled = false
    checkBookingStillActive(booking.token).then((r) => {
      if (!cancelled && !r.active) clearBooking()
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.token])

  // "no open booking to add to" — a pickup order, a scanned station
  // currently unoccupied, and no booking attached via the add-food nudge
  // either — mirrors the server's own re-derivation in placeOnlineOrder
  // (lib/actions/public-orders.ts); this is only ever used to decide what
  // the UI OFFERS, the server never trusts it.
  const standalone = !station?.hasActiveBooking && !booking
  const showPayNow = razorpayConfigured && standalone
  const [payOnline, setPayOnline] = useState(false)

  // Same phone-first identification as the booking wizard
  // (ResourceBookingPage): look the number up as soon as it's long enough to
  // match, and only reveal name/email if the directory doesn't recognise it.
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [phoneLookup, setPhoneLookup] = useState<{ checking: boolean; checked: boolean; found: boolean }>({
    checking: false,
    checked: false,
    found: false,
  })

  // A 10-digit Indian mobile number, same rule lib/customers/phone.ts enforces
  // server-side (normalizePhone/isValidPhone) — checked here too so the field
  // can show its own error and gate the lookup, instead of only failing after
  // a round trip to the server.
  const phoneIsComplete = phone.length === 10
  const phoneIsValid = isValidPhone(phone)
  const phoneError = phoneIsComplete && !phoneIsValid ? 'Enter a valid 10-digit mobile number.' : null

  useEffect(() => {
    setName('')
    if (!phoneIsValid) {
      setPhoneLookup({ checking: false, checked: false, found: false })
      return
    }
    let cancelled = false
    setPhoneLookup({ checking: true, checked: false, found: false })
    const timer = setTimeout(() => {
      lookupPublicCustomerByPhone({ phone }).then((r) => {
        if (cancelled) return
        const found = 'error' in r ? false : r.found
        setPhoneLookup({ checking: false, checked: true, found })
      })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phone, phoneIsValid])

  // Idempotency (migration 0058) — stable across every retry of ONE
  // checkout attempt (the button disables while pending, but a failed
  // network request re-enables it, or the customer just double-taps before
  // that disable paints), so a retry never cooks the food twice. Only
  // regenerated once THIS attempt has fully succeeded (see the two
  // clearCart() call sites below) — the next order is a genuinely new one.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey())

  const hasHappyHourLine = cartLines.some((l) => l.hasDiscount)
  const canPlaceOrder = !pending && phoneLookup.checked && (phoneLookup.found || name.trim().length > 0)
  // Checked by default (M14 #7, v2) — persisted per-customer on every order,
  // so they can change their mind order to order. See lib/notifications/
  // service.ts for what this actually gates.
  const [notifyOrderReady, setNotifyOrderReady] = useState(true)

  function handlePlaceOrder() {
    setError(null)
    startTransition(async () => {
      const wantsPayNow = showPayNow && payOnline
      const res = await placeOnlineOrder({
        stationToken: station?.token,
        bookingToken: booking?.token,
        idempotencyKey,
        items: cartLines.map((l) => ({
          menuItemId: l.menuItemId,
          qty: l.qty,
          specialInstructions: l.specialInstructions.trim() || undefined,
        })),
        customerName: name,
        customerPhone: phone,
        customerEmail: email,
        website,
        payNow: wantsPayNow,
        notifyOrderReady,
      })
      if (res.error) {
        setError(res.error)
        return
      }

      if (res.awaitingPayment && res.orderId) {
        // The cart stays intact until payment is actually submitted — see
        // payForOrder's handler(). If the payment window is abandoned or
        // fails to start, the customer still has their cart to retry with,
        // rather than having to rebuild it from scratch.
        await payForOrder(res.orderId, res.orderNumber ?? '')
        return
      }

      // No online payment involved — the order is placed the moment this
      // resolves, so the cart clears immediately, as it always has.
      clearCart()
      setIdempotencyKey(newIdempotencyKey())
      toast.success(
        res.pendingAcceptance ? `Order #${res.orderNumber} received!` : `Order #${res.orderNumber} sent to the kitchen!`,
        {
          description: res.pendingAcceptance
            ? "The venue is confirming your order — we'll notify you shortly."
            : station?.hasActiveBooking || booking
              ? 'This has been added to your current booking.'
              : station
                ? "We'll bring it out to you shortly."
                : "We'll have it ready for pickup shortly.",
        },
      )
      router.push(`/o/${res.orderId}`)
    })
  }

  /**
   * Open Razorpay Checkout for an order already placed at
   * acceptanceStatus='awaiting_payment'. Same honesty rule as DepositButton:
   * the browser's success callback is unauthenticated client input, never
   * proof of payment — the webhook (lib/payments/webhook.ts) is what actually
   * releases the order to the kitchen. If the payment window is abandoned,
   * the order is left sitting unpaid (a known, accepted limitation — see the
   * M14 #6 plan) rather than silently retried or auto-cancelled.
   *
   * The cart is deliberately NOT cleared by this function except inside
   * `handler()`, once Checkout actually reports a submitted payment — every
   * other exit (intent creation failed, script failed to load, the modal was
   * dismissed) leaves it untouched, so an abandoned or failed payment never
   * costs the customer their cart.
   */
  async function payForOrder(orderId: string, orderNumber: string) {
    const res = await createOrderPaymentIntent({ orderId })
    if (res.error || !res.checkout) {
      setError(res.error ?? 'Could not start the payment.')
      toast.error(`Order #${orderNumber} was placed, but online payment could not be started.`, {
        description: 'Please contact the venue to arrange payment.',
      })
      router.push(`/o/${orderId}`)
      return
    }
    const { orderId: gatewayOrderId, amount, currency: orderCurrency, keyId } = res.checkout

    let Razorpay: RazorpayCtor
    try {
      Razorpay = await loadCheckoutScript()
    } catch {
      setError('Could not load the payment window. Check your connection and try again.')
      toast.error(`Order #${orderNumber} was placed, but the payment window could not load.`, {
        description: 'Please contact the venue to arrange payment.',
      })
      router.push(`/o/${orderId}`)
      return
    }

    const checkout = new Razorpay({
      key: keyId,
      order_id: gatewayOrderId,
      amount,
      currency: orderCurrency,
      name: venueName,
      description: `Order #${orderNumber}`,
      prefill: {
        ...(name ? { name } : {}),
        ...(phone ? { contact: phone } : {}),
      },
      handler: () => {
        // Payment was actually submitted — only now is the cart cleared.
        clearCart()
        setIdempotencyKey(newIdempotencyKey())
        toast.success('Payment submitted — confirming with the venue.', {
          description: "We'll start on your order the moment it clears.",
        })
        router.push(`/o/${orderId}`)
      },
      modal: {
        ondismiss: () => {
          toast(`Order #${orderNumber} is placed but not yet paid.`, {
            description: 'Contact the venue if you’d like to complete payment another way.',
          })
          router.push(`/o/${orderId}`)
        },
      },
    })
    checkout.open()
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
              {cartCount} item{cartCount === 1 ? '' : 's'} ·{' '}
              {station ? station.name : booking ? `Booking #${booking.bookingNumber}` : 'Pickup order'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-primary">
            {station ? (
              <>
                <MapPin size={12} /> {station.name}
              </>
            ) : booking ? (
              <>
                <Ticket size={12} /> Booking #{booking.bookingNumber}
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
          {booking && (
            <p className="rounded-xl bg-primary/5 px-4 py-3 text-sm font-medium text-primary">
              This order will be added to booking #{booking.bookingNumber} — one bill for both.
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
                      disabled={line.qty >= MAX_ORDER_ITEM_QTY}
                      aria-label={line.qty >= MAX_ORDER_ITEM_QTY ? `Maximum ${MAX_ORDER_ITEM_QTY} per item` : 'Add one more'}
                      className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
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

        {/* Right rail: contact details + order summary */}
        <div className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          {/* Contact details */}
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-lg shadow-black/[0.03]">
            <div className="bg-gradient-to-r from-primary/5 via-transparent to-transparent px-5 py-4">
              <h2 className="text-base font-black tracking-tight text-foreground">Your details</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">So the venue knows who this order is for</p>
            </div>

            <div className="px-5 py-4">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <Phone size={14} /> Phone
                </span>
                <div className="relative">
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    readOnly={phoneLookup.checked}
                    autoComplete="tel"
                    maxLength={10}
                    placeholder="10-digit mobile number"
                    aria-invalid={phoneError !== null}
                    className={`w-full rounded-xl border bg-background px-3.5 py-3 text-base outline-none transition focus:ring-2 read-only:bg-muted read-only:text-muted-foreground ${
                      phoneError ? 'border-destructive focus:border-destructive focus:ring-destructive/20' : 'border-border focus:border-primary focus:ring-ring/30'
                    }`}
                  />
                  {phoneLookup.checked && (
                    <button
                      type="button"
                      onClick={() => {
                        setPhone('')
                        setPhoneLookup({ checking: false, checked: false, found: false })
                      }}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary transition hover:underline"
                    >
                      Change
                    </button>
                  )}
                </div>
              </label>

              {phoneError ? (
                <p className="mt-2 text-sm text-destructive">{phoneError}</p>
              ) : phoneLookup.checking ? (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Checking for an existing profile…
                </p>
              ) : phoneLookup.checked && phoneLookup.found ? (
                <p className="mt-3 text-sm text-foreground">
                  <span className="font-semibold">Welcome back!</span> We found a profile for this number —
                  you&apos;re all set to order.
                </p>
              ) : phoneLookup.checked ? (
                <>
                  <label className="mt-4 block">
                    <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                      <User size={14} /> Name
                    </span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      placeholder="Your full name"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                    />
                  </label>

                  <label className="mt-4 block">
                    <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                      <Mail size={14} /> Email <span className="font-normal text-muted-foreground/70">(optional)</span>
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="you@example.com"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                </>
              ) : null}

              {phoneLookup.checked && (
                <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={notifyOrderReady}
                    onChange={(e) => setNotifyOrderReady(e.target.checked)}
                    className="size-4 rounded border-border accent-primary"
                  />
                  Text me when my order is ready
                </label>
              )}

              <HoneypotField value={website} onChange={setWebsite} />
            </div>
          </div>

          {/* Order summary */}
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

            {showPayNow && (
              <div className="border-t border-border/70 px-5 py-4">
                <span className="mb-2 block text-sm font-semibold text-muted-foreground">How would you like to pay?</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPayOnline(false)}
                    className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                      !payOnline
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    <Wallet size={15} /> Pay at pickup
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayOnline(true)}
                    className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                      payOnline
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    <CreditCard size={15} /> Pay online now
                  </button>
                </div>
              </div>
            )}

            <div className="px-5 pb-5">
              {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
              <button
                type="button"
                onClick={handlePlaceOrder}
                disabled={!canPlaceOrder}
                className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />
                {pending && <Loader2 size={16} className="animate-spin" />}
                {pending ? 'Placing order...' : showPayNow && payOnline ? 'Place order & pay' : 'Place order'}
              </button>
              <p className="mt-3 text-center text-[11px] font-medium text-muted-foreground/70">
                {showPayNow && payOnline
                  ? "You'll be asked to pay right after this"
                  : 'Sent directly to the venue the moment you place it'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
