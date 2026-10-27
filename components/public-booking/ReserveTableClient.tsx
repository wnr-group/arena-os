'use client'

import { useEffect, useState, useTransition } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { createPublicReservation, getPublicReservationTimes } from '@/lib/actions/public-reservations'
import type { StartOption } from '@/lib/reservations/service'
import { HoneypotField } from './HoneypotField'

const field = 'w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'

function addDays(dateStr: string, n: number) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Public "Book a table": date + party size → time → contact details → confirmed. */
export function ReserveTableClient({
  tenantName,
  timezone,
  today,
  maxAdvanceDays,
  maxPartySize,
  phone,
}: {
  tenantName: string
  timezone: string
  today: string
  maxAdvanceDays: number
  maxPartySize: number
  phone: string | null
}) {
  const [date, setDate] = useState(today)
  const [partySize, setPartySize] = useState(2)
  const [options, setOptions] = useState<StartOption[] | null>(null)
  const [startsAt, setStartsAt] = useState('')
  const [name, setName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [website, setWebsite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, start] = useTransition()
  const [done, setDone] = useState<{ bookingNumber: string; startsAt: string; partySize: number } | null>(null)

  const dates = Array.from({ length: Math.min(maxAdvanceDays, 14) }, (_, i) => addDays(today, i))
  const tooBig = partySize > maxPartySize

  useEffect(() => {
    if (tooBig) {
      setOptions(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setStartsAt('')
    getPublicReservationTimes({ date, partySize }).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (r.error) {
        setError(r.error)
        setOptions(null)
      } else {
        setError(null)
        setOptions(r.options ?? [])
      }
    })
    return () => {
      cancelled = true
    }
  }, [date, partySize, tooBig])

  function submit() {
    setError(null)
    start(async () => {
      const r = await createPublicReservation({
        startsAt,
        partySize,
        customerName: name,
        customerPhone: guestPhone,
        customerEmail: email || undefined,
        notes: notes || undefined,
        website,
      })
      if (r.error) setError(r.error)
      else if (r.confirmation) setDone(r.confirmation)
    })
  }

  const dayLabel = (d: string) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`))

  if (done) {
    const when = new Intl.DateTimeFormat('en-IN', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(done.startsAt))
    return (
      <div className="mx-auto max-w-lg px-4 py-14 text-center sm:px-6">
        <CheckCircle2 className="mx-auto size-12 text-emerald-500" />
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight">You&apos;re booked!</h1>
        <p className="mt-3 text-lg">
          Table for {done.partySize} at {tenantName}
        </p>
        <p className="mt-1 text-muted-foreground">{when}</p>
        <p className="mt-4 text-sm text-muted-foreground">Reference {done.bookingNumber}. We&apos;ll hold your table for a few minutes after the booked time.</p>
      </div>
    )
  }

  const ready = startsAt && name.trim() && guestPhone.trim() && !tooBig

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Book a table</h1>
      <p className="mt-2 text-muted-foreground">at {tenantName}</p>

      <div className="mt-8 space-y-6 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div>
          <label className={label}>Guests</label>
          <div className="mt-1 flex items-center gap-3">
            <button type="button" aria-label="Fewer guests" className="size-10 rounded-lg border border-border text-lg hover:bg-muted" onClick={() => setPartySize((n) => Math.max(1, n - 1))}>
              −
            </button>
            <span className="w-10 text-center text-xl font-semibold tabular-nums">{partySize}</span>
            <button type="button" aria-label="More guests" className="size-10 rounded-lg border border-border text-lg hover:bg-muted" onClick={() => setPartySize((n) => Math.min(100, n + 1))}>
              +
            </button>
          </div>
          {tooBig && (
            <p className="mt-2 text-sm text-destructive">
              For parties larger than {maxPartySize}, please call us{phone ? ` on ${phone}` : ''}.
            </p>
          )}
        </div>

        <div>
          <label className={label}>Date</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {dates.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDate(d)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${date === d ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
              >
                {d === today ? 'Today' : dayLabel(d)}
              </button>
            ))}
          </div>
        </div>

        {!tooBig && (
          <div>
            <label className={label}>Time</label>
            {loading ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Checking availability…
              </p>
            ) : options && options.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No tables available on this day — try another date.</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-2">
                {(options ?? []).map((o) => (
                  <button
                    key={o.startsAt}
                    type="button"
                    onClick={() => setStartsAt(o.startsAt)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium tabular-nums transition ${startsAt === o.startsAt ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {startsAt && (
          <div className="space-y-3">
            <div>
              <label className={label}>Your name</label>
              <input className={field} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
            <div>
              <label className={label}>Phone</label>
              <input className={field} value={guestPhone} inputMode="tel" autoComplete="tel" onChange={(e) => setGuestPhone(e.target.value.replace(/[^\d+\s-]/g, ''))} />
            </div>
            <div>
              <label className={label}>Email (optional)</label>
              <input className={field} type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className={label}>Anything we should know? (optional)</label>
              <input className={field} value={notes} maxLength={300} placeholder="Birthday, high chair…" onChange={(e) => setNotes(e.target.value)} />
            </div>
            <HoneypotField value={website} onChange={setWebsite} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          onClick={submit}
          disabled={pending || !ready}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-base font-bold text-primary-foreground shadow-lg shadow-primary/20 transition hover:opacity-90 disabled:opacity-50"
        >
          {pending && <Loader2 size={16} className="animate-spin" />}
          Reserve table
        </button>
      </div>
    </div>
  )
}
