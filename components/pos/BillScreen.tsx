'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, ReceiptText, Split } from 'lucide-react'
import { createInvoiceForBooking, previewPromoCodeForBooking, updateBookingHeadCount } from '@/lib/actions/billing'
import {
  computeServiceCharge,
  priceBill,
  round2,
  type BillLine,
  type PricingResult,
  type ServiceChargeConfig,
} from '@/lib/billing/pricing'
import { formatMoney, timeInZone, prettyDate } from '@/lib/format'
import { PaymentPanel, type SettlementView } from './PaymentPanel'
import { SplitBillDialog } from './SplitBillDialog'

type BookingHeader = {
  id: string
  bookingNumber: string
  status: string
  billable: boolean
  branchName: string
  customerName: string | null
  customerPhone: string | null
  startsAt: string | null
  endsAt: string | null
  resourceNames: string[]
  /** M21 per-head #4: a walk-in prices/freezes at checkout, not here — the
   *  Players EDIT control only makes sense pre-bill for a reserved booking. */
  channel: string
  /** 'per_head' when at least one active slot is — null otherwise. */
  pricingMode: string | null
  headCount: number | null
  /** The resource type's live min_players; meaningless when pricingMode is null. */
  minPlayers: number | null
}
type ExistingInvoice = { id: string; invoiceNumber: string; status: string }

/** One check of a split bill (M18 #2) — mirrors lib/billing/data.ts's
 *  CheckView, with Dates already serialised the same way `settlement` is. */
export type SplitCheckView = {
  invoiceId: string
  invoiceNumber: string
  seq: number
  label: string
  settlement: SettlementView
  wallet: { balance: number; maxSpendable: number } | null
}

const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const KIND_LABEL: Record<string, string> = {
  booking: 'Booking',
  food: 'Food',
  membership: 'Membership',
  adjustment: 'Adjustment',
  wallet_topup: 'Wallet top-up',
  service_charge: 'Service charge',
}

/** The POS bill screen for one booking — raise/split the bill pre-issue, or settle it (PaymentPanel) once issued. */
export function BillScreen({
  booking,
  lines,
  existingInvoice,
  settlement,
  issuedPricing,
  taxDrift,
  splitChecks,
  membership,
  wallet,
  loyalty,
  serviceChargeConfig,
  staff,
  isRestaurant,
  isManager,
  timeZone,
  currency,
}: {
  booking: BookingHeader
  lines: BillLine[]
  existingInvoice: ExistingInvoice | null
  /** Present once a bill exists — drives the payment panel. */
  settlement: SettlementView | null
  /** Present once the bill has been SPLIT (M18 #2) — one entry per check,
   *  each with its own independent payment panel. Mutually exclusive with
   *  `existingInvoice`/`settlement`. */
  splitChecks: SplitCheckView[] | null
  /**
   * The issued invoice's own stored pricing. Present once a bill exists, and
   * from that moment it is what the screen shows — the client-side preview
   * below cannot reproduce an issued bill (stored qty is 2dp, and a re-price
   * knows nothing of the discount that was applied), so re-pricing here would
   * put different line totals, GST and grand total on screen from the ones on
   * the invoice and the receipt.
   */
  issuedPricing: PricingResult | null
  /**
   * Food lines whose stored tax rate no longer matches the menu item's. An
   * order freezes the rate when it is taken, so one placed before a rate
   * changed still bills at the old one — correct for a tax document, but
   * invisible without this. Advisory only: nothing here changes what is
   * charged, it just puts the discrepancy in front of the till while re-taking
   * the line is still free.
   */
  taxDrift: { description: string; chargedPercent: number; currentPercent: number }[]
  /**
   * The membership benefit this bill is entitled to (AROS-61), resolved
   * server-side from the customer's purchased snapshot. DISPLAY ONLY — the
   * action re-resolves and re-applies it, and receives nothing from here.
   */
  membership: { planName: string; discountPercent: number; discountAmount: number } | null
  /** Ledger balance and spendable amount for the wallet tender. */
  wallet: { balance: number; maxSpendable: number } | null
  /**
   * Points balance and the tenant's rule, for the redemption control. DISPLAY
   * ONLY: the client sends a point COUNT, and the server prices it, caps it at
   * what is still owed and takes the debit.
   */
  loyalty: { balance: number; pointValue: number; minRedeemPoints: number } | null
  /** The tenant's service charge config (M18 #3), for the pre-bill preview
   *  only — meaningless once a bill/split exists (the frozen amount is
   *  already part of `lines` then). */
  serviceChargeConfig: ServiceChargeConfig
  /** Active staff, for the tip-recipient picker on each payment panel. */
  staff: { id: string; name: string }[]
  /** M18 (split bill / service charge / tips) is restaurant-only. The Split
   *  bill button and every payment panel's tip input are hidden for every
   *  other tenant type — actual enforcement is server-side (the split
   *  actions check this, and service charge always computes to zero). */
  isRestaurant: boolean
  /** Bill-level comp/discount (M18 #5) is manager/owner only. Hides the
   *  control for a cashier — the server re-checks isManager(ctx.role)
   *  regardless, this is UX only, same discipline as isRestaurant above. */
  isManager: boolean
  timeZone: string
  currency: string
}) {
  const router = useRouter()
  const [discountText, setDiscountText] = useState('')
  const [promoCode, setPromoCode] = useState('')
  // What the server says the typed code is worth on THIS bill. Null until the
  // cashier applies one, and cleared the moment the text changes again, so a
  // stale figure can never sit under a different code.
  const [appliedPromo, setAppliedPromo] = useState<{ code: string; discount: number } | null>(null)
  const [promoError, setPromoError] = useState<string | null>(null)
  const [promoPending, startPromo] = useTransition()
  const [redeemText, setRedeemText] = useState('')
  // Bill-level comp/discount (M18 #5) — restaurant + manager only (see
  // canComp below). Deliberately separate from `discountText`: a comp is a
  // manager-authorised write-off with a mandatory reason and an audit
  // trail, not an ordinary keyed-in discount.
  const [compText, setCompText] = useState('')
  const [compReason, setCompReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [splitOpen, setSplitOpen] = useState(false)

  // M21 per-head #4 — the bill screen's Players control.
  const [headCountText, setHeadCountText] = useState(String(booking.headCount ?? booking.minPlayers ?? 1))
  const [headCountError, setHeadCountError] = useState<string | null>(null)
  const [headCountPending, startHeadCount] = useTransition()
  // A walk-in prices/freezes at checkout (WalkinCheckoutDialog/TimedWalkinDialog
  // own that edit instead — see lib/booking/walkin.ts's checkoutWalkinCore),
  // and once a bill exists here the pricing is frozen too — same gate as
  // every other pre-bill-only control on this screen.
  const canEditHeadCount = booking.channel !== 'walkin' && !existingInvoice && !splitChecks
  function saveHeadCount() {
    const n = Number(headCountText)
    if (!Number.isInteger(n) || n < 1) {
      setHeadCountError('Enter a whole number, at least 1.')
      return
    }
    if (booking.minPlayers !== null && n < booking.minPlayers) {
      setHeadCountError(`Needs at least ${booking.minPlayers} player${booking.minPlayers === 1 ? '' : 's'}.`)
      return
    }
    setHeadCountError(null)
    startHeadCount(async () => {
      const r = await updateBookingHeadCount({ bookingId: booking.id, headCount: n })
      if (r.error) {
        setHeadCountError(r.error)
        return
      }
      router.refresh()
    })
  }

  const canComp = isRestaurant && isManager

  const discount = Number(discountText)
  const discountValid = discountText === '' || (Number.isFinite(discount) && discount >= 0)

  // PREVIEW ONLY. The same priceBill the server uses, so what the cashier sees
  // matches what gets written — but the action recomputes everything from the
  // database and never receives a single figure from this component.
  // Mirrors the server precedence exactly (lib/billing/membership-benefit.ts):
  // membership first, then the keyed-in figure against what remains.
  const membershipDiscount = membership?.discountAmount ?? 0

  // Points the cashier has asked to redeem. Validated here for feedback only —
  // the server re-reads the balance under a lock and caps the discount itself.
  const redeemPoints = Number(redeemText)
  const redeemValid =
    redeemText.trim() === '' ||
    (Number.isInteger(redeemPoints) && redeemPoints >= 0 && redeemPoints <= (loyalty?.balance ?? 0))
  const redeemError =
    redeemText.trim() === '' || redeemValid
      ? null
      : !Number.isInteger(redeemPoints) || redeemPoints < 0
        ? 'Enter a whole number of points.'
        : `Only ${loyalty?.balance ?? 0} points available.`

  // What membership + the promo-or-keyed-in discount + loyalty leave for a
  // comp to take (M18 #5) — comp is LAST, same as the server
  // (lib/billing/invoice.ts). Used for the preview and to cap "Full comp".
  const remainingBeforeComp = useMemo(() => {
    const gross = priceBill({ lines })
    const afterMembership = Math.max(0, gross.subtotal - membershipDiscount)
    const promoOff = appliedPromo ? Math.min(appliedPromo.discount, afterMembership) : 0
    const typed = appliedPromo || !discountValid ? 0 : Math.min(discount || 0, afterMembership)
    const afterCodes = Math.max(0, afterMembership - promoOff - typed)
    const wanted = redeemValid && redeemText.trim() !== '' ? redeemPoints : 0
    const loyaltyOff = Math.min(wanted * (loyalty?.pointValue ?? 0), afterCodes)
    return Math.max(0, round2(afterCodes - loyaltyOff))
  }, [
    lines,
    discount,
    discountValid,
    membershipDiscount,
    appliedPromo,
    redeemPoints,
    redeemValid,
    redeemText,
    loyalty,
  ])

  const compAmount = Number(compText)
  const compValid = compText.trim() === '' || (Number.isFinite(compAmount) && compAmount >= 0)
  // Only restaurant managers can comp at all — a cashier's or another
  // industry's typed figure never reduces the preview.
  const compCapped = canComp && compValid ? Math.min(compAmount || 0, remainingBeforeComp) : 0
  const compReasonMissing = compCapped > 0 && compReason.trim() === ''

  // Mirrors the server precedence exactly (lib/billing/loyalty.ts):
  // membership → promo/keyed-in → loyalty, all before GST.
  //
  // Returns the components as well as the pricing, so the breakdown below
  // itemises the very figures that went into the total instead of inferring
  // them back out of it.
  const { preview, promoDiscount, keyedDiscount, loyaltyPreviewDiscount } = useMemo(() => {
    const gross = priceBill({ lines })
    const afterMembership = Math.max(0, gross.subtotal - membershipDiscount)
    // The server REPLACES a keyed-in discount with the promo's value rather
    // than stacking the two (lib/billing/invoice.ts, step 4b), so the preview
    // drops the typed figure the moment a code is applied.
    const promoOff = appliedPromo ? Math.min(appliedPromo.discount, afterMembership) : 0
    const typed = appliedPromo || !discountValid ? 0 : Math.min(discount || 0, afterMembership)
    const afterCodes = Math.max(0, afterMembership - promoOff - typed)
    const wanted = redeemValid && redeemText.trim() !== '' ? redeemPoints : 0
    const loyaltyOff = Math.min(wanted * (loyalty?.pointValue ?? 0), afterCodes)
    return {
      preview: priceBill({
        lines,
        discount: membershipDiscount + promoOff + typed + loyaltyOff + compCapped,
      }),
      promoDiscount: promoOff,
      keyedDiscount: typed,
      loyaltyPreviewDiscount: loyaltyOff,
    }
  }, [
    lines,
    discount,
    discountValid,
    membershipDiscount,
    appliedPromo,
    redeemPoints,
    redeemValid,
    redeemText,
    loyalty,
    compCapped,
  ])

  const promoEntered = promoCode.trim() !== ''
  // A typed discount that the applied promo has just displaced. Worth saying
  // out loud, otherwise the figure in the box above looks ignored.
  const keyedDiscountOverridden =
    Boolean(appliedPromo) && discountValid && (discount || 0) > 0

  // What the screen renders: the invoice's frozen figures once it exists,
  // the live preview until then. Never a re-price of an issued bill.
  const pricing = issuedPricing ?? preview

  const bookingItems = pricing.items.filter((i) => i.kind === 'booking')
  const foodItems = pricing.items.filter((i) => i.kind === 'food')
  // Present only once a bill/split already exists — `lines` then came from the
  // frozen invoice_items, which include the service-charge line written at
  // issue time. Pre-bill there is none yet; serviceChargePreview covers that.
  const serviceChargeItems = pricing.items.filter((i) => i.kind === 'service_charge')

  // PRE-BILL preview only (M18 #3) — computed client-side purely so the
  // cashier sees the line and the grand total move before raising the
  // bill; issueInvoiceForBooking re-resolves the config and recomputes this
  // server-side, same trust model as the discount preview above.
  const serviceChargePreview = computeServiceCharge(preview.subtotal, serviceChargeConfig)
  const grandTotal = round2(preview.taxableValue + serviceChargePreview.amount + preview.taxTotal + serviceChargePreview.tax)

  const blocked = Boolean(existingInvoice) || Boolean(splitChecks) || !booking.billable || lines.length === 0
  const canSplit = isRestaurant && !existingInvoice && !splitChecks && booking.billable && lines.length > 0
  /** Format a rupee amount for display in the tenant's own currency. */
  const money = (n: number) => formatMoney(n, currency)

  // The by-item split picker's source list — same gross per-item value the
  // split math itself reads (priceBill's items are priced BEFORE any
  // discount, so this is identical regardless of what's typed above).
  const itemsForSplit = useMemo(
    () =>
      pricing.items
        .filter((i) => i.kind === 'food' && i.sourceId)
        .map((i) => ({
          sourceId: i.sourceId as string,
          description: i.description,
          qty: i.qty,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
        })),
    [pricing.items],
  )

  // Typing a new code invalidates whatever was applied: the totals fall back
  // to no promo until the server has priced the new one.
  function changePromoCode(next: string) {
    setPromoCode(next.toUpperCase())
    setAppliedPromo(null)
    setPromoError(null)
  }

  // Prices the code server-side. Records nothing — the use is taken only when
  // the bill is raised — so this is safe to repeat.
  function applyPromo() {
    const code = promoCode.trim()
    if (!code || blocked || pending || promoPending) return
    setPromoError(null)
    startPromo(async () => {
      const r = await previewPromoCodeForBooking({ bookingId: booking.id, promoCode: code })
      if (r.error || r.discount === undefined || !r.code) {
        setAppliedPromo(null)
        setPromoError(r.error ?? 'Could not apply that promo code.')
        return
      }
      setAppliedPromo({ code: r.code, discount: r.discount })
    })
  }

  function generate() {
    if (blocked || pending) return
    if (!discountValid) {
      setError('Enter a discount of zero or more.')
      return
    }
    if (!redeemValid) {
      setError(redeemError ?? 'Check the points to redeem.')
      return
    }
    // A typed-but-unapplied code would still be honoured by the server while
    // the totals on screen showed full price. Price it first, so what the
    // cashier confirms is what the customer is charged.
    if (promoEntered && !appliedPromo) {
      setError('Apply the promo code to see what it takes off.')
      return
    }
    setError(null)
    start(async () => {
      const r = await createInvoiceForBooking({
        bookingId: booking.id,
        // Only the discount travels. No prices, no totals, no tax.
        discount: discountText === '' ? undefined : discount,
        promoCode: promoCode.trim() || undefined,
        // Only a COUNT of points travels. No rupee value, no balance.
        redeemPoints: redeemText.trim() === '' ? undefined : redeemPoints,
        // Bill-level comp (M18 #5) — the server re-checks isManager(ctx.role)
        // and the restaurant gate regardless of what canComp shows here.
        compAmount: canComp && compText.trim() !== '' ? compAmount : undefined,
        compReason: canComp && compText.trim() !== '' ? compReason.trim() : undefined,
      })
      if (r.error || !r.invoiceId) {
        setError(r.error ?? 'Could not raise the bill.')
        return
      }
      // Stay on the POS screen: refreshing swaps the bill form for the payment
      // panel, which is where the cashier settles the invoice. (The receipt
      // route /invoices/[id] is still to be built — see AROS-26 scope.)
      router.refresh()
    })
  }

  return (
    <div className="px-6 py-6">
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={15} /> Bookings
      </Link>

      {/* ── booking header ── */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bill · {booking.bookingNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {booking.customerName || 'Walk-in'}
            {booking.customerPhone && ` · ${booking.customerPhone}`}
            {' · '}
            {booking.branchName}
          </p>
          <p className="text-sm text-muted-foreground">
            {booking.startsAt && (
              <>
                {prettyDate(booking.startsAt.slice(0, 10), timeZone)} ·{' '}
                {timeInZone(booking.startsAt, timeZone)}
                {booking.endsAt && `–${timeInZone(booking.endsAt, timeZone)}`}
              </>
            )}
            {booking.resourceNames.length > 0 && ` · ${booking.resourceNames.join(', ')}`}
          </p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs font-medium capitalize">
          {booking.status.replace('_', ' ')}
        </span>
      </div>

      {/* ── players (M21 per-head #4) ── */}
      {booking.pricingMode === 'per_head' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium text-foreground">Players</span>
          {canEditHeadCount ? (
            <>
              <input
                type="number"
                min={booking.minPlayers ?? 1}
                step={1}
                value={headCountText}
                onChange={(e) => setHeadCountText(e.target.value)}
                disabled={headCountPending}
                className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary disabled:opacity-50"
              />
              <button
                type="button"
                onClick={saveHeadCount}
                disabled={headCountPending || headCountText === String(booking.headCount ?? '')}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {headCountPending && <Loader2 size={12} className="animate-spin" />} Update
              </button>
              <span className="text-xs text-muted-foreground">
                Re-prices the whole session · min {booking.minPlayers ?? 1}
              </span>
              {headCountError && <span className="text-xs text-destructive">{headCountError}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{booking.headCount ?? '—'}</span>
          )}
        </div>
      )}

      {/* ── blocking states ── */}
      {existingInvoice && (
        <Notice tone="info">
          Billed as <span className="font-medium">{existingInvoice.invoiceNumber}</span>. The
          pricing is frozen — settle the balance in the payment panel.{' '}
          <Link href={`/invoices/${existingInvoice.id}`} className="font-medium underline">
            View GST invoice
          </Link>
        </Notice>
      )}
      {splitChecks && (
        <Notice tone="info">
          Split into {splitChecks.length} checks. Each is settled independently below — the table
          closes once every check is paid.
        </Notice>
      )}
      {!existingInvoice && !splitChecks && !booking.billable && (
        <Notice tone="warn">This booking cannot be billed in its current status.</Notice>
      )}
      {!existingInvoice && !splitChecks && booking.billable && lines.length === 0 && (
        <Notice tone="warn">This booking has nothing to bill.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {taxDrift.length > 0 && (
        <Notice tone="warn">
          <span className="font-medium">Tax rates have changed since these were ordered.</span>{' '}
          This bill charges the rate stored on the order, which is the rate that
          applied when the food was served:
          <ul className="mt-1 list-disc pl-5">
            {taxDrift.map((d) => (
              <li key={d.description}>
                {d.description} — billing at {d.chargedPercent}%, the menu is now{' '}
                {d.currentPercent}%
              </li>
            ))}
          </ul>
          <span className="mt-1 block">
            To charge the current rate, void the line and take it again before
            raising the bill.
          </span>
        </Notice>
      )}

      {splitChecks ? (
        <div className="mt-6 space-y-6">
          <LineTable title="Booking charges" items={bookingItems} money={money} />
          {foodItems.length > 0 && <LineTable title="Food & beverage" items={foodItems} money={money} />}
          {serviceChargeItems.length > 0 && (
            <LineTable title="Service charge" items={serviceChargeItems} money={money} />
          )}

          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Checks ({splitChecks.length})
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {splitChecks.map((c) => (
                <div key={c.invoiceId}>
                  <p className="mb-1.5 text-sm font-medium">{c.label}</p>
                  <PaymentPanel
                    key={c.settlement.paid}
                    settlement={c.settlement}
                    wallet={c.wallet}
                    staff={staff}
                    isRestaurant={isRestaurant}
                    timeZone={timeZone}
                    currency={currency}
                    // Settling THIS check completes the booking only when every
                    // OTHER check is already paid — i.e. this is the last one owing.
                    completesBooking={splitChecks.every((o) => o.invoiceId === c.invoiceId || !o.settlement.payable)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* ── lines ── */}
        <div className="space-y-6">
          <LineTable title="Booking charges" items={bookingItems} money={money} />
          {foodItems.length > 0 && (
            <LineTable title="Food & beverage" items={foodItems} money={money} />
          )}
          {serviceChargeItems.length > 0 && (
            <LineTable title="Service charge" items={serviceChargeItems} money={money} />
          )}
        </div>

        {/* ── settle: once a bill exists the pricing is frozen, so the discount
             form gives way to the payment panel ── */}
        {settlement ? (
          <div className="space-y-4">
            {/* The bill as issued. Every figure is read off the invoice, so it
                agrees with the GST receipt and with the balance the panel below
                is collecting — the three cannot drift apart. */}
            {issuedPricing && (
              <aside className="space-y-3 rounded-lg border p-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Bill
                </h2>
                <TotalRows pricing={issuedPricing} money={money} />
                <p className="text-center text-xs text-muted-foreground">
                  Frozen when the bill was raised. The GST invoice itemises the
                  discount.
                </p>
              </aside>
            )}
            {/* Keyed on what has been taken so the amount field re-defaults to
                the new balance after each tender. */}
            <PaymentPanel
              key={settlement.paid}
              settlement={settlement}
              wallet={wallet}
              staff={staff}
              isRestaurant={isRestaurant}
              timeZone={timeZone}
              currency={currency}
              // A single (non-split) bill: settling it completes the booking.
              completesBooking
            />
          </div>
        ) : (
        <aside className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="discount" className="text-sm font-medium">
              Discount
            </label>
            <input
              id="discount"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={discountText}
              onChange={(e) => setDiscountText(e.target.value)}
              disabled={blocked || pending}
              placeholder="0.00"
              className={`mt-1 ${input}`}
            />
            {!discountValid && (
              <p className="mt-1 text-xs text-destructive">Enter zero or more.</p>
            )}
          </div>

          <div>
            <label htmlFor="promo" className="text-sm font-medium">
              Promo code
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="promo"
                value={promoCode}
                onChange={(e) => changePromoCode(e.target.value)}
                onKeyDown={(e) => {
                  // Enter in this field means "apply", not "raise the bill".
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    applyPromo()
                  }
                }}
                disabled={blocked || pending}
                placeholder="e.g. WELCOME10"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className={`${input} disabled:cursor-not-allowed disabled:opacity-60`}
              />
              <button
                type="button"
                onClick={applyPromo}
                disabled={
                  blocked || pending || promoPending || !promoEntered || Boolean(appliedPromo)
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                {promoPending && <Loader2 size={14} className="animate-spin" />}
                {appliedPromo ? 'Applied' : 'Apply'}
              </button>
            </div>
            {/* The figure below is the server's — the same validatePromo() the
                invoice uses, against the same base — so the totals move by
                exactly what the customer will be charged. Applying burns no
                use; raising the bill does that, re-validating from scratch. */}
            {promoError ? (
              <p className="mt-1 text-xs text-destructive">{promoError}</p>
            ) : appliedPromo ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {appliedPromo.code} applied · {money(promoDiscount)} off
                {keyedDiscountOverridden && ' · replaces the discount above'}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {promoEntered
                  ? 'Apply the code to include it in the totals below.'
                  : 'Overrides the discount above when applied.'}
              </p>
            )}
          </div>

          {/* ── loyalty redemption ──
              Only a point COUNT is sent. The server re-reads the balance under
              a lock, caps the discount at what is still owed after the
              membership benefit and the promo, and debits only the points that
              funded it — so the figure below is a preview, not an instruction. */}
          {loyalty && (
            <div>
              <label htmlFor="redeem" className="text-sm font-medium">
                Redeem points
              </label>
              <input
                id="redeem"
                type="number"
                min={0}
                step="1"
                value={redeemText}
                onChange={(e) => setRedeemText(e.target.value)}
                disabled={blocked || pending || loyalty.balance <= 0}
                placeholder="0"
                className={`mt-1 ${input} disabled:cursor-not-allowed disabled:opacity-60`}
              />
              {redeemError ? (
                <p className="mt-1 text-xs text-destructive">{redeemError}</p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {loyalty.balance > 0
                    ? `${loyalty.balance} available · 1 point = ${money(loyalty.pointValue)}`
                    : 'No points available.'}
                  {loyalty.minRedeemPoints > 0 && ` · minimum ${loyalty.minRedeemPoints}`}
                </p>
              )}
            </div>
          )}

          {/* ── bill-level comp/discount (M18 #5) ──
              Restaurant + manager/owner only. The server re-checks both
              (lib/actions/billing.ts's resolveCompInput) regardless of what
              canComp hides here, and writes an audit_log row with the
              actor, amount and reason whenever this is used. */}
          {canComp && (
            <div className="rounded-md border border-dashed p-3">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="comp" className="text-sm font-medium">
                  Comp / discount whole bill
                </label>
                <button
                  type="button"
                  onClick={() => setCompText(remainingBeforeComp.toFixed(2))}
                  disabled={blocked || pending || remainingBeforeComp <= 0}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Full comp
                </button>
              </div>
              <input
                id="comp"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={compText}
                onChange={(e) => setCompText(e.target.value)}
                disabled={blocked || pending}
                placeholder="0.00"
                className={`mt-1 ${input}`}
              />
              {!compValid && <p className="mt-1 text-xs text-destructive">Enter zero or more.</p>}
              {compCapped > 0 && (
                <>
                  <textarea
                    value={compReason}
                    onChange={(e) => setCompReason(e.target.value)}
                    disabled={blocked || pending}
                    placeholder="Reason (required) — e.g. service recovery, VIP, staff meal"
                    rows={2}
                    className={`mt-2 ${input}`}
                  />
                  {compReasonMissing && (
                    <p className="mt-1 text-xs text-destructive">A reason is required to comp or discount a bill.</p>
                  )}
                </>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">
                Applied last, on top of the discount above — capped at what remains and logged to the audit trail.
              </p>
            </div>
          )}

          <TotalRows
            pricing={preview}
            money={money}
            className="border-t pt-4"
            serviceCharge={serviceChargePreview}
            total={grandTotal}
          >
            {/* These itemise the Discount line rather than adding to it: each is
                one component of it, all applied before GST. */}
            {membership && (
              <Total
                k={`${membership.planName} member · ${membership.discountPercent}%`}
                v={`− ${money(membership.discountAmount)}`}
                muted
              />
            )}
            {appliedPromo && (
              <Total
                k={`Promo · ${appliedPromo.code}`}
                v={`− ${money(promoDiscount)}`}
                muted
              />
            )}
            {keyedDiscount > 0 && (
              <Total k="Keyed-in discount" v={`− ${money(keyedDiscount)}`} muted />
            )}
            {loyaltyPreviewDiscount > 0 && (
              <Total
                k={`Loyalty · ${redeemPoints} points`}
                v={`− ${money(loyaltyPreviewDiscount)}`}
                muted
              />
            )}
            {compCapped > 0 && <Total k="Comp / discount" v={`− ${money(compCapped)}`} muted />}
          </TotalRows>

          <button
            onClick={generate}
            disabled={
              blocked ||
              pending ||
              promoPending ||
              !discountValid ||
              !compValid ||
              compReasonMissing ||
              (promoEntered && !appliedPromo)
            }
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : <ReceiptText size={16} />}
            {pending ? 'Generating…' : 'Generate bill'}
          </button>
          {canSplit && (
            <button
              type="button"
              onClick={() => setSplitOpen(true)}
              disabled={pending}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
            >
              <Split size={16} /> Split bill
            </button>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Totals are recalculated on the server when the bill is raised.
          </p>
        </aside>
        )}
      </div>
      )}

      {splitOpen && (
        <SplitBillDialog
          bookingId={booking.id}
          items={itemsForSplit}
          currency={currency}
          canComp={canComp}
          onClose={() => setSplitOpen(false)}
          onSplit={() => {
            setSplitOpen(false)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function LineTable({
  title,
  items,
  money,
}: {
  title: string
  items: { description: string; kind: string; qty: number; unitPrice: number; taxPercent: number; lineTotal: number }[]
  money: (n: number) => string
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing to bill here.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-base">
            <thead>
              <tr className="border-b text-left text-sm uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Unit</th>
                <th className="py-2 pr-3 text-right font-medium">Tax</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, n) => (
                <tr key={`${i.description}-${n}`} className="border-b last:border-0">
                  <td className="py-2 pr-3">{i.description}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{KIND_LABEL[i.kind] ?? i.kind}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{i.qty}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(i.unitPrice)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {i.taxPercent}%
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * Subtotal → discount → GST → grand total, from ONE PricingResult.
 *
 * Shared by the preview and the issued bill on purpose: the two states differ
 * only in where the figures come from, never in how they are added up or
 * labelled, so there is no second implementation to drift.
 *
 * `children` slot in directly under the Discount line to itemise it.
 */
function TotalRows({
  pricing,
  money,
  className = '',
  serviceCharge,
  total,
  children,
}: {
  pricing: PricingResult
  money: (n: number) => string
  className?: string
  /**
   * The PRE-BILL service charge preview (M18 #3). Passed only before a bill
   * exists: once one does, the charge is a frozen invoice LINE and is already
   * inside `pricing`, so passing it here would count it twice.
   */
  serviceCharge?: { percent: number; amount: number; tax: number }
  /** Overrides the grand total — used with `serviceCharge`, which sits outside `pricing`. */
  total?: number
  children?: React.ReactNode
}) {
  // Aggregating the per-rate split the way the receipt does — stored amounts
  // summed, never re-derived from a percentage.
  const gst = pricing.taxBreakup.reduce(
    (acc, g) => ({ cgst: acc.cgst + g.cgst, sgst: acc.sgst + g.sgst }),
    { cgst: 0, sgst: 0 },
  )
  return (
    <dl className={`space-y-1.5 text-sm ${className}`}>
      <Total k="Subtotal" v={money(pricing.subtotal)} />
      <Total k="Discount" v={`− ${money(pricing.discount)}`} />
      {children}
      <Total k="Taxable value" v={money(pricing.taxableValue)} muted />
      <Total k="CGST" v={money(gst.cgst)} muted />
      <Total k="SGST" v={money(gst.sgst)} muted />
      <Total k="GST total" v={money(pricing.taxTotal)} />
      {serviceCharge && serviceCharge.amount > 0 && (
        <Total
          k={`Service charge (${serviceCharge.percent}%)`}
          v={money(serviceCharge.amount + serviceCharge.tax)}
          muted
        />
      )}
      <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
        <dt>Grand total</dt>
        <dd>{money(total ?? pricing.total)}</dd>
      </div>
    </dl>
  )
}

function Total({ k, v, muted = false }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? 'text-muted-foreground' : ''}`}>
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : tone === 'info'
        ? 'border-border bg-muted/50 text-muted-foreground'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
  return <p className={`mt-4 rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</p>
}
