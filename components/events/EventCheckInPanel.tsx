'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, QrCode, UserPlus, XCircle } from 'lucide-react'
import { checkInEventRegistrationByToken, promoteEventWaitlist } from '@/lib/actions/events'

/**
 * The day-of check-in desk for one event (M15 #5).
 *
 * Two controls beside the live counts: scan a QR, and promote the next
 * waitlisted entrant when someone does not turn up.
 *
 * ── Presentation only ───────────────────────────────────────────────────────
 *
 * Nothing here decides anything. Both actions call requireManager() server-side
 * and every rule — eligibility, capacity, FIFO order, whether a paid entry has
 * actually been paid for — lives in lib/events/check-in.ts and in the database
 * functions it delegates to. This component's whole job is to put a result in
 * front of the person at the door.
 *
 * ── Why a text input rather than only a camera ──────────────────────────────
 *
 * Exactly the reason components/bookings/ScanCheckIn.tsx gives: a venue's
 * hardware is usually a keyboard-wedge scanner, which types the code and
 * presses Enter. That works here with no camera permission, no HTTPS
 * requirement and no BarcodeDetector support. A phone camera can paste into the
 * same box. The action accepts a full URL or a bare token either way.
 */

type Counts = {
  registered: number
  checkedIn: number
  confirmed: number
  waitlisted: number
  pendingPayment: number
  cancelled: number
}

type LastScan =
  | { kind: 'ok'; name: string; team: string | null; at: string | null; already: boolean }
  | { kind: 'error'; message: string }

export function EventCheckInPanel({
  eventId,
  counts,
  capacity,
}: {
  eventId: string
  counts: Counts
  capacity: number | null
}) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [last, setLast] = useState<LastScan | null>(null)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the caret in the box: a wedge scanner types wherever focus happens to
  // be, and a lost focus means a scan silently goes nowhere.
  useEffect(() => {
    inputRef.current?.focus()
  }, [last])

  function submit(raw: string) {
    const value = raw.trim()
    if (!value) return
    startTransition(async () => {
      const r = await checkInEventRegistrationByToken(value)
      setCode('')
      if (r.error || !r.entrant) {
        setLast({ kind: 'error', message: r.error ?? 'Check-in failed.' })
      } else {
        setLast({
          kind: 'ok',
          name: r.entrant.customerName ?? 'Entrant',
          team: r.entrant.teamName,
          at: r.entrant.checkedInAt,
          already: r.entrant.alreadyCheckedIn,
        })
        router.refresh()
      }
    })
  }

  function promote() {
    startTransition(async () => {
      const r = await promoteEventWaitlist(eventId)
      if (r.error) toast.error(r.error)
      else if (r.promoted && r.promoted > 0) {
        toast.success(`${r.promoted} promoted from the waitlist.`)
        router.refresh()
      } else {
        // Not an error: a full event legitimately promotes nobody.
        toast.message('No free place — cancel or no-show a confirmed entry first.')
      }
    })
  }

  const time = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* ── live counts ────────────────────────────────────────────────
            "Registered" is the strict status: confirmed but NOT yet arrived.
            The three headline numbers therefore partition the confirmed set
            rather than overlapping, and the label says so. */}
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Expected</dt>
            <dd className="text-2xl font-semibold tabular-nums">{counts.registered}</dd>
            <dd className="text-xs text-muted-foreground">registered, not yet in</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Checked in</dt>
            <dd className="text-2xl font-semibold tabular-nums text-emerald-600">
              {counts.checkedIn}
            </dd>
            <dd className="text-xs text-muted-foreground">
              of {counts.confirmed} confirmed
              {capacity !== null ? ` · cap ${capacity}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Waitlisted</dt>
            <dd className="text-2xl font-semibold tabular-nums text-amber-600">
              {counts.waitlisted}
            </dd>
            {counts.pendingPayment > 0 && (
              <dd className="text-xs text-muted-foreground">
                {counts.pendingPayment} awaiting payment
              </dd>
            )}
          </div>
        </dl>

        <button
          type="button"
          onClick={promote}
          disabled={pending || counts.waitlisted === 0}
          className="rounded-lg border border-border px-3.5 py-2.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          title={
            counts.waitlisted === 0
              ? 'Nobody is waiting'
              : 'Move the next waitlisted entrant into a free place'
          }
        >
          <span className="flex items-center gap-1.5">
            <UserPlus size={16} aria-hidden /> Promote next
          </span>
        </button>
      </div>

      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit(code)
        }}
      >
        <label htmlFor="ev-scan" className="sr-only">
          Scan or type a check-in code
        </label>
        <div className="relative min-w-0 flex-1">
          <QrCode
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="ev-scan"
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan a ticket QR, or paste the code"
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !code.trim()}
          className="rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : 'Check in'}
        </button>
      </form>

      {last && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${
            last.kind === 'error'
              ? 'bg-destructive/10 text-destructive'
              : last.already
                ? 'bg-amber-500/10 text-amber-700'
                : 'bg-emerald-500/10 text-emerald-700'
          }`}
        >
          {last.kind === 'error' ? (
            <XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden />
          )}
          <span>
            {last.kind === 'error' ? (
              last.message
            ) : last.already ? (
              <>
                <strong>Already checked in</strong> — {last.name}
                {last.team ? ` (${last.team})` : ''}
                {last.at ? `, at ${time(last.at)}` : ''}
              </>
            ) : (
              <>
                <strong>Checked in</strong> — {last.name}
                {last.team ? ` (${last.team})` : ''}
                {last.at ? `, ${time(last.at)}` : ''}
              </>
            )}
          </span>
        </div>
      )}
    </section>
  )
}
