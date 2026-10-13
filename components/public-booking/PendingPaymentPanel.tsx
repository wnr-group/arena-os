'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CreditCard, Loader2, TimerOff } from 'lucide-react'
import { createBookingPaymentIntentByToken } from '@/lib/actions/public-booking'
import { formatMoney } from '@/lib/format'
import { openBookingCheckout } from './booking-checkout'

const POLL_MS = 3_000
/** Stop polling after this many refreshes (~2 minutes) and say it is taking long. */
const MAX_POLLS = 40

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso))
}

/**
 * The /b/[token] view of an advance/full booking that is not confirmed yet
 * (M36 #5). Three honest states, never "confirmed" while unpaid:
 *
 *  - just paid (?paid=1): "Confirming your payment…" — polls the real status; the
 *    browser callback is not proof, only the webhook flips the booking.
 *  - held: "Payment not completed — your slot is held until hh:mm" + Retry
 *    (reuses the booking's pending order; never a second booking) + start over.
 *  - expired / released: "This hold expired" + a way back to pick a time again.
 */
export function PendingPaymentPanel({
  token,
  bookingNumber,
  deposit,
  holdExpiresAt,
  holdReleased,
  justPaid,
  tenantName,
  timeZone,
  currency,
  customerName,
}: {
  token: string
  bookingNumber: string
  deposit: string
  holdExpiresAt: string | null
  holdReleased: boolean
  justPaid: boolean
  tenantName: string
  timeZone: string
  currency: string
  customerName: string | null
}) {
  const router = useRouter()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [polls, setPolls] = useState(0)
  const retrying = useRef(false)

  const expired = holdReleased || (holdExpiresAt !== null && new Date(holdExpiresAt).getTime() <= now)
  const pollingDone = polls >= MAX_POLLS
  const waiting = justPaid && !pollingDone

  // Poll the server for the webhook's verdict while we wait for the money, and STOP
  // after MAX_POLLS: each refresh re-renders the whole server page, so an open tab
  // whose webhook never arrives must not keep hitting it forever.
  useEffect(() => {
    if (!justPaid || pollingDone) return
    const id = setInterval(() => {
      setPolls((p) => p + 1)
      router.refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [justPaid, pollingDone, router])

  // Tick so the countdown state flips to "expired" without a reload.
  useEffect(() => {
    if (expired || !holdExpiresAt) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [expired, holdExpiresAt])

  async function retry() {
    if (retrying.current) return // double-click protection: one attempt at a time
    retrying.current = true
    setBusy(true)
    setError(null)
    const res = await createBookingPaymentIntentByToken({ token })
    if (res.error || !res.checkout) {
      setError(res.error ?? 'Could not start the payment. Please try again.')
      retrying.current = false
      setBusy(false)
      return
    }
    const opened = await openBookingCheckout({
      checkout: res.checkout,
      tenantName,
      bookingNumber,
      name: customerName ?? undefined,
      onSubmitted: () => {
        router.replace(`/b/${token}?paid=1`)
        router.refresh()
      },
      onDismissed: () => {
        retrying.current = false
        setBusy(false)
      },
    })
    if (!opened.ok) {
      setError(opened.error)
      retrying.current = false
      setBusy(false)
    }
  }

  const box = 'mt-6 rounded-2xl border p-5 text-center shadow-sm'

  if (waiting) {
    return (
      <div className={`${box} border-primary/20 bg-primary/5`} role="status" aria-live="polite">
        <Loader2 className="mx-auto animate-spin text-primary" size={26} />
        <p className="mt-3 text-sm font-bold text-foreground">Confirming your payment…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This usually takes a few seconds. Please keep this page open.
        </p>
      </div>
    )
  }

  if (expired) {
    return (
      <div className={`${box} border-border bg-card`} role="status">
        <TimerOff className="mx-auto text-muted-foreground" size={26} />
        <p className="mt-3 text-sm font-bold text-foreground">This hold expired</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The payment wasn&apos;t completed in time, so the slot was released. If you were charged, the venue will
          sort it out with you — nothing more is needed from you.
        </p>
        <Link
          href="/resources"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Pick a time again
        </Link>
      </div>
    )
  }

  return (
    <div className={`${box} border-amber-500/30 bg-amber-500/5`}>
      <p className="text-sm font-bold text-foreground" role="status">
        {justPaid
          ? 'Still confirming your payment'
          : holdExpiresAt
            ? `Payment not completed — your slot is held until ${clock(holdExpiresAt, timeZone)}`
            : 'Payment not completed'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {justPaid
          ? 'This is taking longer than usual. If you were charged, your booking will confirm on its own — you can leave this page.'
          : `Pay ${formatMoney(deposit, currency)} to confirm booking #${bookingNumber}.`}
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {!justPaid && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
            Retry payment
          </button>
          <Link
            href="/resources"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-muted-foreground transition hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Start over
          </Link>
        </div>
      )}
    </div>
  )
}
