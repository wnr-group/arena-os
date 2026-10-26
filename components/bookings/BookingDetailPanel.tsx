'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Ban, Loader2, Minus, Plus, ReceiptText, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { DepositButton } from './DepositButton'
import { CancelBookingDialog } from './CancelBookingDialog'
import { RescheduleBookingDialog } from './RescheduleBookingDialog'
import { BookingAddonsDialog } from './BookingAddonsDialog'
import { PAYMENT_LABELS, SOURCE_LABELS } from './bookingBadges'
import { VoidCompDialog } from '@/components/orders/VoidCompDialog'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { setBookingStatus, undoCheckIn } from '@/lib/actions/bookings'
import { editOrderItemQuantity, removeOrderItem } from '@/lib/actions/orders'
import { fireCourse } from '@/lib/actions/kds'
import { formatMoney, timeInZone } from '@/lib/format'
import { lateEntryLabel } from '@/lib/booking/late-entry'
import type { BookingPaymentState } from '@/lib/billing/data'

export type OrderItemLine = {
  itemId: string
  itemName: string
  unitPrice: string
  qty: number
  specialInstructions: string | null
  /** Set only when a happy-hour rule discounted this line at order time. */
  happyHourName: string | null
  originalUnitPrice: string | null
  happyHourDiscountType: 'percentage' | 'fixed' | null
  happyHourDiscountValue: string | null
  /** M17 #6 — 'active' unless voided/comped (only ever reached via an
   *  approved request — see pendingVoidMode below). */
  voidStatus: 'active' | 'voided' | 'comped'
  voidReason: string | null
  /** Set while a void/comp request on this line awaits manager approval. */
  pendingVoidMode: 'void' | 'comp' | null
  /** Chosen modifier option names (M17 #8) — e.g. ["Large", "Extra cheese"]. */
  modifiers: string[]
  /** Course firing (M19 #2). `held` = not yet sent to the cook. */
  courseNo: number
  courseName: string | null
  held: boolean
}
export type OrderSummary = { orderId: string; orderNumber: string; status: string; items: OrderItemLine[] }

/**
 * The booking fields the detail panel reads. A day-view slot satisfies this as
 * is; the multi-day list (M34 #4) builds it from a booking-level row.
 */
export type PanelBooking = {
  bookingId: string
  bookingNumber: string
  customerName: string | null
  customerPhone: string | null
  status: string
  source: string
  /** bookings.total (post-discount). */
  total: string
  /** Rupees, 2dp — DISPLAY ONLY. The server re-reads this to charge. */
  deposit: string
  /** Cash collected before the booking existed ('0.00' when none). */
  advancePaid: string
  /** Sum of slot_total over the booking's ACTIVE slots (0 once cancelled / no-show). */
  bookingActiveSlotTotal: string
  startsAt: string
  /** Null for an open-tab walk-in still running. */
  endsAt: string | null
  cancellationReason: string | null
  backdated: boolean
  bookingCreatedAt: string
}

/** The slice of a booking's till state the panel shows (invoiceCount is not needed). */
export type PanelPaymentState = Omit<BookingPaymentState, 'invoiceCount'>

/**
 * M26 #5: how far a booking's cash advance falls short of its known total —
 * the live, pre-bill "Part paid" signal. Undefined when there is no advance or
 * it covers the total. Only meaningful for a booking with no live invoice.
 */
export function advanceGapOf(b: Pick<PanelBooking, 'advancePaid' | 'bookingActiveSlotTotal'>): number | undefined {
  const advance = Number(b.advancePaid)
  if (advance <= 0) return undefined
  const gap = Number(b.bookingActiveSlotTotal) - advance
  return gap > 0.004 ? gap : undefined
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium capitalize">{v}</dd>
    </div>
  )
}

function ActBtn({
  label,
  onClick,
  pending,
  loading = false,
  variant = 'primary',
}: {
  label: string
  onClick: () => void
  pending: boolean
  loading?: boolean
  variant?: 'primary' | 'danger' | 'muted'
}) {
  const cls =
    variant === 'danger'
      ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
      : variant === 'muted'
        ? 'border hover:bg-muted'
        : 'bg-primary text-primary-foreground hover:opacity-90'
  return (
    <button
      onClick={onClick}
      disabled={pending}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${cls}`}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {label}
    </button>
  )
}

/**
 * Booking detail drawer plus the dialogs its actions open (cancel, add-ons,
 * void/comp). Extracted from BookingsView so the day timeline and the multi-day
 * list (M34 #4) run the same correction actions — one implementation, not a fork.
 *
 * `booking` null renders no drawer, but already-open dialogs stay mounted until
 * they finish. After a successful action the panel calls `onClose` and
 * `router.refresh()`, so the host's server data (and its rows) re-render.
 */
export function BookingDetailPanel({
  booking: selected,
  timeZone,
  currency,
  venueName,
  depositStates,
  paymentStates,
  ordersByBooking,
  canRequestVoidComp,
  canEditAddons = false,
  showFoodOrdering,
  addOrder,
  onClose,
}: {
  booking: PanelBooking | null
  timeZone: string
  currency: string
  venueName: string
  depositStates: Record<string, 'pending' | 'paid'>
  paymentStates: Record<string, PanelPaymentState>
  ordersByBooking: Record<string, OrderSummary[]>
  canRequestVoidComp: boolean
  canEditAddons?: boolean
  showFoodOrdering: boolean
  /** Omit to hide "Add order" (the host has no menu loaded). */
  addOrder?: { disabled: boolean; onClick: (b: { bookingId: string; bookingLabel: string }) => void }
  onClose: () => void
}) {
  const router = useRouter()
  const [cancelTarget, setCancelTarget] = useState<PanelBooking | null>(null)
  const [rescheduleTarget, setRescheduleTarget] = useState<PanelBooking | null>(null)
  // M33: the unbilled-booking add-ons correction dialog.
  const [addonsTarget, setAddonsTarget] = useState<PanelBooking | null>(null)
  const [voidTarget, setVoidTarget] = useState<{ itemId: string; itemName: string; qty: number } | null>(null)
  const [pending, start] = useTransition()
  const [actingAction, setActingAction] = useState<string | null>(null)
  // M25 #3: separate from `pending` — editing/removing an order line must not
  // disable the booking's own action bar, and must NOT close the drawer the
  // way act() does on success.
  const [lineActionId, setLineActionId] = useState<string | null>(null)
  const [linePending, startLine] = useTransition()
  const confirm = useConfirm()

  const advanceGap = selected ? advanceGapOf(selected) : undefined

  function editQty(itemId: string, newQty: number) {
    setLineActionId(itemId)
    startLine(async () => {
      const r = await editOrderItemQuantity({ orderItemId: itemId, newQty })
      setLineActionId(null)
      if (r.error) toast.error(r.error)
      else router.refresh()
    })
  }

  async function removeLine(itemId: string, itemName: string) {
    await confirm({
      title: `Remove ${itemName}?`,
      description: 'This line was never served or billed — it will be removed outright, not voided.',
      confirmText: 'Remove',
      onConfirm: async () => {
        setLineActionId(itemId)
        startLine(async () => {
          const r = await removeOrderItem(itemId)
          setLineActionId(null)
          if (r.error) toast.error(r.error)
          else router.refresh()
        })
      },
    })
  }

  function act(action: string, fn: () => Promise<{ error?: string }>) {
    setActingAction(action)
    start(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        onClose()
        router.refresh()
      }
      setActingAction(null)
    })
  }

  return (
    <>
      {selected && (
        // While the reschedule view is open it takes this modal's place (same screen
        // slot, "Back" returns here) instead of stacking a second modal on top. Kept
        // mounted, just hidden, so nothing in the details view resets.
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 ${rescheduleTarget ? 'hidden' : ''}`}
          onClick={() => onClose()}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{selected.bookingNumber}</h2>
              <button onClick={() => onClose()} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row k="Customer" v={selected.customerName || 'Walk-in'} />
              {selected.customerPhone && <Row k="Phone" v={selected.customerPhone} />}
              <Row k="Source" v={SOURCE_LABELS[selected.source] ?? selected.source} />
              {selected.backdated && (
                <div>
                  <span className="inline-flex items-center rounded-full bg-violet-600 px-2 py-0.5 text-xs font-medium text-white">
                    Entered late
                  </span>
                  <p className="mt-1 text-muted-foreground">
                    {lateEntryLabel(selected.bookingCreatedAt, selected.startsAt, timeZone)}
                  </p>
                </div>
              )}
              <Row
                k="Time"
                v={`${timeInZone(selected.startsAt, timeZone)}–${selected.endsAt ? timeInZone(selected.endsAt, timeZone) : 'Ongoing'}`}
              />
              <Row k="Status" v={selected.status.replace('_', ' ')} />
              <Row
                k="Total"
                v={formatMoney(paymentStates[selected.bookingId]?.total ?? Math.max(Number(selected.total), Number(selected.bookingActiveSlotTotal)), currency)}
              />
              {/* M36 #6: the ONLINE advance (Razorpay) — labelled apart from the cash
                  "Collected upfront" below so the two are never confused. */}
              {Number(selected.deposit) > 0 &&
                (depositStates[selected.bookingId] === 'paid' ? (
                  <>
                    <Row k="Online advance paid" v={formatMoney(selected.deposit, currency)} />
                    {/* Billed: the invoice's own balance (tax included). Not billed yet: the
                        pre-tax booking total minus the advance — an estimate, labelled so. */}
                    {paymentStates[selected.bookingId] ? (
                      <Row k="Balance at the venue" v={formatMoney(paymentStates[selected.bookingId].balance, currency)} />
                    ) : (
                      <Row
                        k="Balance at the venue (estimate, before tax)"
                        v={formatMoney(Math.max(Number(selected.total) - Number(selected.deposit), 0), currency)}
                      />
                    )}
                  </>
                ) : (
                  <Row
                    k={selected.status === 'pending_payment' ? 'Online advance (awaiting payment)' : 'Online advance (unpaid)'}
                    v={formatMoney(selected.deposit, currency)}
                  />
                ))}
              {/* M26 #5: cash collected upfront (M26 #1/#4) — 0 for every
                  non-gaming_cafe tenant, so this row is already a no-op there. */}
              {Number(selected.advancePaid) > 0 && (
                <Row k="Collected upfront (cash)" v={formatMoney(selected.advancePaid, currency)} />
              )}
              {/* Billed figures come off the invoice, not from the booking:
                  the bill is what was actually charged, discounts and all. */}
              <Row
                k="Payment"
                v={
                  PAYMENT_LABELS[
                    paymentStates[selected.bookingId]?.status ??
                      (advanceGap ? 'partially_paid' : 'unbilled')
                  ]
                }
              />
              {paymentStates[selected.bookingId] ? (
                <>
                  <Row
                    k="Billed"
                    v={formatMoney(paymentStates[selected.bookingId].total, currency)}
                  />
                  <Row
                    k="Paid"
                    v={formatMoney(paymentStates[selected.bookingId].paid, currency)}
                  />
                  {paymentStates[selected.bookingId].refunded > 0 && (
                    <Row
                      k="Refunded"
                      v={formatMoney(paymentStates[selected.bookingId].refunded, currency)}
                    />
                  )}
                  {paymentStates[selected.bookingId].balance > 0 && (
                    <Row
                      k="Balance due"
                      v={formatMoney(paymentStates[selected.bookingId].balance, currency)}
                    />
                  )}
                </>
              ) : (
                advanceGap && (
                  <Row k="Estimated balance due" v={formatMoney(advanceGap, currency)} />
                )
              )}
            </dl>

            {/* Online deposit. The button sends only a booking id — the amount
                shown above is a label, and the server prices the order itself. */}
            {(selected.status === 'confirmed' || selected.status === 'checked_in') && (
              <div className="mt-3">
                <DepositButton
                  bookingId={selected.bookingId}
                  bookingNumber={selected.bookingNumber}
                  depositAmount={selected.deposit}
                  currency={currency}
                  venueName={venueName}
                  customerName={selected.customerName}
                  customerPhone={selected.customerPhone}
                  depositStatus={depositStates[selected.bookingId] ?? 'none'}
                />
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {/* Once a bill exists its receipt is the authority on what was
                  charged and what is still owed, so link straight to it. */}
              {paymentStates[selected.bookingId] && (
                <Link
                  href={`/invoices/${paymentStates[selected.bookingId].invoiceId}`}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted"
                >
                  <ReceiptText size={15} />{' '}
                  {paymentStates[selected.bookingId].invoiceNumber}
                </Link>
              )}
              {/* M25 #4: discoverability for the existing refund -> void ->
                  re-raise correction, right from the booking a wrong bill
                  was raised against — not a new capability, and the invoice
                  page itself still hides Refund/Void for a non-manager. */}
              {paymentStates[selected.bookingId] && (
                <Link
                  href={`/invoices/${paymentStates[selected.bookingId].invoiceId}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
                >
                  Wrong bill? Correct it
                </Link>
              )}
              {/* Only the statuses lib/billing/invoice.ts will actually bill.
                  The action re-checks — hiding a link is not authorization. */}
              {(selected.status === 'confirmed' || selected.status === 'checked_in') && (
                <Link
                  href={`/pos/${selected.bookingId}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  <ReceiptText size={15} /> Bill
                </Link>
              )}
              {/* M33: add-ons are editable only while the booking is open AND
                  unbilled (no live invoice -> paymentStates absent). The action
                  re-checks both server-side. */}
              {canEditAddons &&
                (selected.status === 'confirmed' || selected.status === 'checked_in') &&
                !paymentStates[selected.bookingId] && (
                  <ActBtn label="Add-ons" variant="muted" onClick={() => setAddonsTarget(selected)} pending={pending} />
                )}
              {selected.status === 'confirmed' && (
                <ActBtn
                  label="Check in"
                  onClick={() => act('check_in', () => setBookingStatus(selected.bookingId, 'checked_in'))}
                  pending={pending}
                  loading={actingAction === 'check_in'}
                />
              )}
              {/* M25 #1: reverts an accidental check-in. Hidden once a bill
                  exists (paymentStates absence means no live invoice, same
                  signal the receipt link above already uses) — the action
                  re-checks server-side regardless, this just keeps staff
                  from hitting that error needlessly. */}
              {selected.status === 'checked_in' && !paymentStates[selected.bookingId] && (
                <ActBtn
                  label="Undo check-in"
                  variant="muted"
                  onClick={() => act('undo_check_in', () => undoCheckIn(selected.bookingId))}
                  pending={pending}
                  loading={actingAction === 'undo_check_in'}
                />
              )}
              {/* No standalone "Complete" here: a booking now completes only as
                  part of settling its bill (recordPayment auto-completes once
                  every check is fully paid — lib/booking/service.ts
                  completeBookingIfFullySettled). Completing an unbilled booking
                  by hand used to strand it (unbillable afterward), so that path
                  is gone; staff go to "Bill" and collect payment instead. */}
              {selected.status === 'confirmed' && (
                <ActBtn
                  label="No-show"
                  variant="muted"
                  onClick={() => act('no_show', () => setBookingStatus(selected.bookingId, 'no_show'))}
                  pending={pending}
                  loading={actingAction === 'no_show'}
                />
              )}
              {/* Reschedule: moves a reserved booking's time. Hidden once billed or for a
                  late entry. NOT keyed on `source`: staff-made counter bookings carry
                  source 'walk_in' too. A real walk-in session (channel 'walkin') is refused
                  by the action, which re-checks everything. */}
              {(selected.status === 'confirmed' || selected.status === 'checked_in') &&
                !selected.backdated &&
                !paymentStates[selected.bookingId] && (
                  <ActBtn label="Reschedule" variant="muted" onClick={() => setRescheduleTarget(selected)} pending={pending} />
                )}
              {(selected.status === 'confirmed' || selected.status === 'checked_in') && (
                <ActBtn label="Cancel" variant="danger" onClick={() => setCancelTarget(selected)} pending={pending} />
              )}
            </div>

            {selected.status === 'cancelled' && selected.cancellationReason && (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">Cancellation reason</p>
                <p className="mt-0.5 text-muted-foreground">{selected.cancellationReason}</p>
              </div>
            )}

            {showFoodOrdering && (
            <div className="mt-4 border-t pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">Food orders</h3>
                {/* Only while the booking is still active — createOrderCore
                    (lib/orders/service.ts) enforces the same rule server-side,
                    this just keeps staff from hitting that error needlessly
                    on a booking that's already completed/cancelled/no-show. */}
                {addOrder && (selected.status === 'confirmed' || selected.status === 'checked_in') && (
                  <button
                    onClick={() => addOrder.onClick({ bookingId: selected.bookingId, bookingLabel: selected.bookingNumber })}
                    disabled={addOrder.disabled}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    <Plus size={14} /> Add order
                  </button>
                )}
              </div>
              {(ordersByBooking[selected.bookingId] ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No food orders yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {(ordersByBooking[selected.bookingId] ?? []).map((o) => (
                    <div key={o.orderId} className="rounded-md border p-2.5 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{o.orderNumber}</span>
                        <span className="text-xs capitalize text-muted-foreground">{o.status}</span>
                      </div>
                      {o.status === 'open' && (
                        <HeldCourseBar items={o.items} orderId={o.orderId} />
                      )}
                      <ul className="mt-1 space-y-0.5">
                        {o.items.map((it) => (
                          <li
                            key={it.itemId}
                            className={`flex justify-between gap-2 text-muted-foreground ${it.voidStatus !== 'active' ? 'opacity-50' : ''}`}
                          >
                            <span className="truncate">
                              <span className={it.voidStatus !== 'active' ? 'line-through' : undefined}>
                                {it.qty}× {it.itemName}
                              </span>
                              {it.modifiers.length > 0 && (
                                <span className="ml-1 text-xs text-primary">— {it.modifiers.join(', ')}</span>
                              )}
                              {it.courseName && (
                                <span
                                  className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                    it.held ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground'
                                  }`}
                                >
                                  {it.held ? `Held · ${it.courseName}` : it.courseName}
                                </span>
                              )}
                              {it.specialInstructions ? ` — ${it.specialInstructions}` : ''}
                              {it.happyHourName && (
                                <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                                  {it.happyHourName}
                                </span>
                              )}
                              {it.voidStatus !== 'active' && (
                                <span
                                  className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                                    it.voidStatus === 'comped'
                                      ? 'bg-accent text-primary'
                                      : 'bg-destructive/10 text-destructive'
                                  }`}
                                  title={it.voidReason ?? undefined}
                                >
                                  {it.voidStatus === 'comped' ? 'Comped' : 'Voided'}
                                </span>
                              )}
                              {it.voidStatus === 'active' && it.pendingVoidMode && (
                                <span
                                  className="ml-1.5 inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                                  title="Awaiting manager approval"
                                >
                                  {it.pendingVoidMode === 'comp' ? 'Comp requested' : 'Void requested'}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5 text-right">
                              {it.originalUnitPrice && Number(it.originalUnitPrice) !== Number(it.unitPrice) && (
                                <span className="line-through opacity-60">
                                  {formatMoney(Number(it.originalUnitPrice) * it.qty, currency)}
                                </span>
                              )}
                              <span className={it.voidStatus !== 'active' ? 'line-through' : undefined}>
                                {formatMoney(Number(it.unitPrice) * it.qty, currency)}
                              </span>
                              {/* M25 #3: in-place quantity correction — every
                                  industry, no manager gate (unlike the
                                  void/comp button below, which stays
                                  restaurant-only). editOrderItemQuantity/
                                  removeOrderItem re-check server-side that
                                  the order is still 'open' regardless of
                                  this UI gate. */}
                              {it.voidStatus === 'active' && !it.pendingVoidMode && o.status === 'open' && (
                                <span className="flex items-center gap-0.5">
                                  <button
                                    type="button"
                                    disabled={linePending && lineActionId === it.itemId}
                                    onClick={() => editQty(it.itemId, it.qty - 1)}
                                    title={it.qty <= 1 ? 'Remove (quantity would drop to 0)' : 'Decrease quantity'}
                                    className="rounded p-0.5 text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Minus size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={linePending && lineActionId === it.itemId}
                                    onClick={() => editQty(it.itemId, it.qty + 1)}
                                    title="Increase quantity"
                                    className="rounded p-0.5 text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Plus size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={linePending && lineActionId === it.itemId}
                                    onClick={() => removeLine(it.itemId, it.itemName)}
                                    title="Remove this line"
                                    className="rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {linePending && lineActionId === it.itemId ? (
                                      <Loader2 size={12} className="animate-spin" />
                                    ) : (
                                      <Trash2 size={12} />
                                    )}
                                  </button>
                                </span>
                              )}
                              {canRequestVoidComp && it.voidStatus === 'active' && !it.pendingVoidMode && o.status === 'open' && (
                                <button
                                  type="button"
                                  onClick={() => setVoidTarget({ itemId: it.itemId, itemName: it.itemName, qty: it.qty })}
                                  title="Void or comp this item"
                                  className="rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Ban size={13} />
                                </button>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      )}

      {voidTarget && (
        <VoidCompDialog
          item={voidTarget}
          onClose={() => setVoidTarget(null)}
          onDone={(mode, status) => {
            setVoidTarget(null)
            if (status === 'pending') {
              toast.success('Sent for manager approval.')
            } else {
              toast.success(mode === 'comp' ? 'Item comped.' : 'Item voided.')
            }
            router.refresh()
          }}
        />
      )}

      {addonsTarget && (
        <BookingAddonsDialog
          bookingId={addonsTarget.bookingId}
          bookingLabel={`${addonsTarget.bookingNumber} · ${addonsTarget.customerName || 'Walk-in'}`}
          currency={currency}
          onClose={() => setAddonsTarget(null)}
          onSaved={() => {
            setAddonsTarget(null)
            router.refresh()
          }}
        />
      )}

      {rescheduleTarget && (
        <RescheduleBookingDialog
          bookingId={rescheduleTarget.bookingId}
          currency={currency}
          onClose={() => setRescheduleTarget(null)}
          onDone={() => {
            const number = rescheduleTarget.bookingNumber
            setRescheduleTarget(null)
            onClose()
            router.refresh()
            toast.success(`Booking ${number} rescheduled.`)
          }}
        />
      )}

      {cancelTarget && (
        <CancelBookingDialog
          bookingId={cancelTarget.bookingId}
          title={`Cancel booking ${cancelTarget.bookingNumber}?`}
          description={`This will cancel ${cancelTarget.customerName || 'this walk-in'}'s booking. This cannot be undone.`}
          onClose={() => setCancelTarget(null)}
          onDone={() => {
            setCancelTarget(null)
            onClose()
            router.refresh()
            toast.success(`Booking ${cancelTarget.bookingNumber} cancelled.`)
          }}
        />
      )}
    </>
  )
}

/**
 * "Fire Mains" buttons for an order's held courses (M19 #2). One button per
 * distinct held course, ordered by course number. Renders nothing for the
 * (vast majority of) orders with no held lines. fireCourse / fire_order_course
 * re-check role, plan and the venue's opt-in server-side.
 */
function HeldCourseBar({ items, orderId }: { items: OrderItemLine[]; orderId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [firing, setFiring] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const held = new Map<number, string>()
  for (const it of items) {
    if (it.held && it.voidStatus !== 'voided') held.set(it.courseNo, it.courseName ?? `Course ${it.courseNo}`)
  }
  if (held.size === 0) return null

  function fire(course: number) {
    setError(null)
    setFiring(course)
    start(async () => {
      const r = await fireCourse(orderId, course)
      if (r.error) setError(r.error)
      else router.refresh()
      setFiring(null)
    })
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      {[...held.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([course, name]) => (
          <button
            key={course}
            type="button"
            disabled={pending}
            onClick={() => fire(course)}
            className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-black transition hover:bg-amber-400 disabled:opacity-50"
          >
            {pending && firing === course && <Loader2 size={12} className="animate-spin" />}
            Fire {name}
          </button>
        ))}
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
