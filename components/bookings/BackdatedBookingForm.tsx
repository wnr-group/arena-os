'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { quoteBackdatedBooking, recordBackdatedBooking } from '@/lib/actions/backdated-bookings'
import { lookupCustomerByPhone } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney } from '@/lib/format'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'
import { addDays, zonedTimeToUtc } from '@/lib/booking/time'
import { BACKDATED_MAX_DAYS as MAX_DAYS_BACK, isPriorMonthDate } from '@/lib/booking/backdated-window'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { wizardInput, wizardLabel } from '@/components/bookings/new/wizard-ui'

export type BackdatedResource = {
  id: string
  name: string
  typeName: string
  pricingMode: string
  minPlayers: number
  includedPlayers: number
  hasSurcharge: boolean
  setups: { id: string; name: string }[]
}

type Preview = { subtotal: number; discount: number; tax: number; total: number; computedSubtotal: number }


/**
 * The owner/manager "Record a past booking" form (M28 #3). The date limits
 * here are a convenience matching the server's rule; recordBackdatedBooking
 * enforces the real 45-day / already-ended window itself.
 */
export function BackdatedBookingForm({
  branchId,
  timeZone,
  currency,
  today,
  resources,
}: {
  branchId: string
  timeZone: string
  currency: string
  today: string
  resources: BackdatedResource[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startSubmit] = useTransition()
  // One key per form, so a double-click or retry of the same submission dedupes.
  const [idempotencyKey] = useState(() => newIdempotencyKey())

  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '')
  const [setupId, setSetupId] = useState('')
  const [date, setDate] = useState(addDays(today, -1))
  const [startTime, setStartTime] = useState('10:00')
  const [endTime, setEndTime] = useState('11:00')
  const [headCount, setHeadCount] = useState(2)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const nameTypedRef = useRef(false)
  const [nameLoading, setNameLoading] = useState(false)
  const [notes, setNotes] = useState('')
  const [method, setMethod] = useState<'cash' | 'card' | 'upi'>('cash')
  // null = follow the preview total until the manager types their own figure.
  const [amountText, setAmountText] = useState<string | null>(null)
  // null = bill the app's computed session charge; otherwise the manager's own
  // figure (lower = a discount, higher = an increase).
  const [chargeText, setChargeText] = useState<string | null>(null)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resource = resources.find((r) => r.id === resourceId)
  const isPerHead = resource?.pricingMode === 'per_head'
  // M29 #4: a board with an extra-player rate takes a player count too (the
  // server refuses a surcharge booking without one).
  const takesPlayers = isPerHead || Boolean(resource?.hasSurcharge)
  useEffect(() => {
    if (resource?.hasSurcharge) setHeadCount(resource.includedPlayers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])
  const minDate = addDays(today, -MAX_DAYS_BACK)

  // Wall-clock -> instants. An end at or before the start means the session ran
  // past midnight, so it ends on the following day.
  const window = useMemo(() => {
    if (!date || !startTime || !endTime) return null
    const start = zonedTimeToUtc(date, startTime, timeZone)
    let end = zonedTimeToUtc(date, endTime, timeZone)
    if (end <= start) end = zonedTimeToUtc(addDays(date, 1), endTime, timeZone)
    return { startsAt: start.toISOString(), endsAt: end.toISOString() }
  }, [date, startTime, endTime, timeZone])

  const slots = useMemo(
    () =>
      resource && window
        ? [{ resourceId: resource.id, startsAt: window.startsAt, endsAt: window.endsAt, setupId: setupId || undefined }]
        : null,
    [resource, window, setupId],
  )

  const chargeNum = chargeText === null || chargeText.trim() === '' ? undefined : Number(chargeText)
  const chargeValid = chargeNum === undefined || (Number.isFinite(chargeNum) && chargeNum >= 0)
  const sessionCharge = chargeNum !== undefined && chargeValid ? chargeNum : undefined

  // Fill the name for a returning customer once a full phone number is typed.
  // A name the manager typed themselves is never overwritten.
  useEffect(() => {
    if (!isValidPhone(customerPhone)) {
      setNameLoading(false)
      return
    }
    let cancelled = false
    setNameLoading(true)
    const timer = setTimeout(() => {
      lookupCustomerByPhone(customerPhone)
        .then((r) => {
          if (cancelled) return
          setNameLoading(false)
          if (nameTypedRef.current) return
          // Unknown number: drop a name we filled for the previous number.
          setCustomerName(r.found && r.name ? r.name : '')
        })
        .catch(() => {
          if (!cancelled) setNameLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [customerPhone])

  // A different session means a different computed price: drop the old override.
  useEffect(() => {
    setChargeText(null)
    setAmountText(null)
  }, [slots, headCount])

  // Live, server-computed price: the real create + invoice path, rolled back —
  // so weekend/holiday/happy-hour/per-head/GST all match what is charged.
  useEffect(() => {
    if (!slots) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    const timer = setTimeout(() => {
      quoteBackdatedBooking({
        branchId,
        slots,
        headCount: takesPlayers ? headCount : undefined,
        sessionCharge,
        customerPhone: isValidPhone(customerPhone) ? customerPhone : undefined,
      })
        .then((r) => {
          if (cancelled) return
          setPreviewLoading(false)
          if (r.error || !r.preview) {
            setPreview(null)
            setPreviewError(r.error ?? 'Could not price this booking.')
          } else {
            setPreview(r.preview)
          }
        })
        .catch(() => {
          if (cancelled) return
          setPreviewLoading(false)
          setPreview(null)
          setPreviewError('Could not price this booking.')
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [branchId, slots, takesPlayers, headCount, customerPhone, sessionCharge])

  const amount = amountText ?? (preview ? String(preview.total) : '')
  const amountNum = Number(amount)
  const canSubmit =
    !!slots &&
    !!preview &&
    !previewLoading &&
    // The name lookup for a newly typed phone may still be in flight: submitting
    // then would carry the PREVIOUS customer's auto-filled name.
    !nameLoading &&
    chargeValid &&
    customerName.trim() !== '' &&
    isValidPhone(customerPhone) &&
    amount !== '' &&
    Number.isFinite(amountNum) &&
    amountNum >= 0

  async function submit() {
    if (!slots || !canSubmit) return
    setError(null)
    // A date in an earlier calendar month may belong to a tax period that is
    // already filed. Not a block - a manager can always continue.
    if (isPriorMonthDate(date, today)) {
      const yes = await confirm({
        title: 'This date is in a previous month',
        description: 'Some tax periods may already be filed. Continue?',
        confirmText: 'Continue',
      })
      if (!yes) return
    }
    startSubmit(async () => {
      const r = await recordBackdatedBooking({
        branchId,
        customerName,
        customerPhone,
        customerEmail,
        notes: notes || undefined,
        slots,
        headCount: takesPlayers ? headCount : undefined,
        sessionCharge,
        amountCollected: amountNum,
        paymentMethod: method,
        idempotencyKey,
      })
      if (r.error || !r.bookingId) {
        setError(r.error ?? 'Something went wrong.')
        return
      }
      toast.success(`Recorded ${r.bookingNumber} · invoice ${r.invoiceNumber}`)
      router.push(`/pos/${r.bookingId}`)
    })
  }

  if (resources.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">Add a resource before recording a booking.</div>
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <Link href="/bookings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Bookings
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Record a past booking</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        For a session that already happened but was never logged (up to {MAX_DAYS_BACK} days back). It is saved as
        completed, billed and paid in one step, and marked as entered late. It may overlap other bookings, and you can
        change the charge.
      </p>

      <div className="mt-6 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="bd-resource" className={wizardLabel}>
              Resource
            </label>
            <select
              id="bd-resource"
              className={`${wizardInput} mt-1`}
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value)
                setSetupId('')
              }}
            >
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.typeName}
                </option>
              ))}
            </select>
          </div>
          {resource && resource.setups.length > 0 && (
            <div>
              <label htmlFor="bd-setup" className={wizardLabel}>
                Setup
              </label>
              <select id="bd-setup" className={`${wizardInput} mt-1`} value={setupId} onChange={(e) => setSetupId(e.target.value)}>
                <option value="">Standard rate</option>
                {resource.setups.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {takesPlayers && (
            <div>
              <label htmlFor="bd-heads" className={wizardLabel}>
                Players
              </label>
              <input
                id="bd-heads"
                type="number"
                min={isPerHead ? (resource?.minPlayers ?? 1) : 1}
                className={`${wizardInput} mt-1`}
                value={headCount}
                onChange={(e) => setHeadCount(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="bd-date" className={wizardLabel}>
              Date
            </label>
            <input
              id="bd-date"
              type="date"
              className={`${wizardInput} mt-1`}
              value={date}
              min={minDate}
              max={today}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="bd-start" className={wizardLabel}>
              Start time
            </label>
            <input id="bd-start" type="time" className={`${wizardInput} mt-1`} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label htmlFor="bd-end" className={wizardLabel}>
              End time
            </label>
            <input id="bd-end" type="time" className={`${wizardInput} mt-1`} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="bd-phone" className={wizardLabel}>
              Customer phone
            </label>
            <input
              id="bd-phone"
              type="tel"
              inputMode="numeric"
              className={`${wizardInput} mt-1`}
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="bd-name" className={wizardLabel}>
              Customer name
            </label>
            <div className="relative">
              <input
                id="bd-name"
                className={`${wizardInput} mt-1 ${nameLoading ? 'pr-9' : ''}`}
                value={customerName}
                placeholder={nameLoading ? 'Looking up customer…' : undefined}
                aria-busy={nameLoading}
                onChange={(e) => {
                  nameTypedRef.current = e.target.value !== ''
                  setCustomerName(e.target.value)
                }}
              />
              {nameLoading && (
                <Loader2 size={15} className="absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
          <div>
            <label htmlFor="bd-email" className={wizardLabel}>
              Email (optional)
            </label>
            <input id="bd-email" type="email" className={`${wizardInput} mt-1`} value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="bd-notes" className={wizardLabel}>
              Notes (optional)
            </label>
            <input id="bd-notes" className={`${wizardInput} mt-1`} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <div>
          <label htmlFor="bd-charge" className={wizardLabel}>
            Session charge (before tax)
          </label>
          <input
            id="bd-charge"
            type="number"
            min={0}
            step="0.01"
            className={`${wizardInput} mt-1`}
            value={chargeText ?? (preview ? String(preview.computedSubtotal) : '')}
            onChange={(e) => {
              setChargeText(e.target.value)
              setAmountText(null)
            }}
          />
          {preview && sessionCharge !== undefined && sessionCharge !== preview.computedSubtotal ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {sessionCharge < preview.computedSubtotal ? 'Discounted' : 'Increased'} from{' '}
              {formatMoney(preview.computedSubtotal, currency)} (the calculated price).{' '}
              <button type="button" className="underline" onClick={() => setChargeText(null)}>
                Reset
              </button>
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Calculated from the rates on that day. Edit to charge a different amount.</p>
          )}
        </div>

        {/* live price */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Bill for this session</span>
            {previewLoading && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
          </div>
          {previewError ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {previewError}
            </p>
          ) : preview ? (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Session charge</dt>
                <dd>{formatMoney(preview.subtotal, currency)}</dd>
              </div>
              {preview.discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd>−{formatMoney(preview.discount, currency)}</dd>
                </div>
              )}
              {preview.tax > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Tax</dt>
                  <dd>{formatMoney(preview.tax, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-border pt-1 font-semibold">
                <dt>Total</dt>
                <dd>{formatMoney(preview.total, currency)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Pick a resource and time to see the price.</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="bd-amount" className={wizardLabel}>
              Amount collected
            </label>
            <input
              id="bd-amount"
              type="number"
              min={0}
              step="0.01"
              className={`${wizardInput} mt-1`}
              value={amount}
              onChange={(e) => setAmountText(e.target.value)}
            />
            {preview && amount !== '' && amountNum < preview.total && (
              <p className="mt-1 text-xs text-muted-foreground">
                Less than the total — the booking will stay open with the balance still due.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="bd-method" className={wizardLabel}>
              Payment method
            </label>
            <select
              id="bd-method"
              className={`${wizardInput} mt-1`}
              value={method}
              onChange={(e) => setMethod(e.target.value as 'cash' | 'card' | 'upi')}
            >
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="upi">UPI</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || pending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Record booking
          </button>
        </div>
      </div>
    </div>
  )
}
