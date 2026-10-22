'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BellRing, Loader2, MessageCircle, Phone, Plus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  addToWaitlist,
  getWaitQuote,
  notifyWaitlistParty,
  removeFromWaitlist,
  seatFromWaitlist,
} from '@/lib/actions/waitlist'
import { isValidPhone } from '@/lib/customers/phone'
import { isOverQuote, waitedMinutes, waitlistSummary } from '@/lib/waitlist/rules'

const POLL_MS = 10000
const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'

export type WaitlistItem = {
  id: string
  name: string
  phone: string | null
  partySize: number
  quotedWaitMinutes: number | null
  notes: string | null
  status: string
  /** ISO */
  createdAt: string
  notifiedAt: string | null
}

export type WaitlistTable = { id: string; name: string; occupied: boolean }

function AddDialog({ branchId, onClose, onAdded }: { branchId: string; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [party, setParty] = useState('2')
  const [quote, setQuote] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    getWaitQuote(branchId).then((r) => {
      if (!r.estimate) return
      setQuote(String(r.estimate.minutes))
      setHint(
        r.estimate.minutes === 0
          ? 'A table is free right now.'
          : `Suggested from ~${r.estimate.avgTurnMinutes} min average turnover and ${r.estimate.queueAhead} ahead in line.`,
      )
    })
  }, [branchId])

  const n = Number(party)
  const phoneError = phone.trim() && !isValidPhone(phone) ? 'Enter a valid 10-digit phone number.' : null
  const ready = name.trim() && Number.isInteger(n) && n > 0 && !phoneError

  function submit() {
    setError(null)
    start(async () => {
      const r = await addToWaitlist({
        branchId,
        name: name.trim(),
        phone: phone.trim() || undefined,
        partySize: n,
        quotedWaitMinutes: quote.trim() === '' ? null : Number(quote),
      })
      if (r.error) setError(r.error)
      else onAdded()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Add to waitlist</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Name</label>
            <input className={input} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Guests</label>
              <input className={input} type="number" min={1} inputMode="numeric" value={party} onChange={(e) => setParty(e.target.value)} />
            </div>
            <div>
              <label className={label}>Quoted wait (min)</label>
              <input className={input} type="number" min={0} inputMode="numeric" value={quote} onChange={(e) => setQuote(e.target.value)} />
            </div>
          </div>
          {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
          <div>
            <label className={label}>Phone (to tell them when it&apos;s ready)</label>
            <input className={input} value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))} />
            {phoneError && <p className="mt-1 text-sm text-destructive">{phoneError}</p>}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            onClick={submit}
            disabled={pending || !ready}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />} Add party
          </button>
        </div>
      </div>
    </div>
  )
}

function SeatDialog({
  entry,
  tables,
  onClose,
  onSeated,
}: {
  entry: WaitlistItem
  tables: WaitlistTable[]
  onClose: () => void
  onSeated: () => void
}) {
  const [tableId, setTableId] = useState(tables.find((t) => !t.occupied)?.id ?? '')
  const [covers, setCovers] = useState(String(entry.partySize))
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [pending, start] = useTransition()
  const n = Number(covers)

  function submit(override = false) {
    setError(null)
    start(async () => {
      const r = await seatFromWaitlist({ entryId: entry.id, resourceId: tableId, coverCount: n, overrideReservation: override || undefined })
      if (r.error) {
        setError(r.error)
        setConflict(Boolean(r.reservationConflict))
      } else onSeated()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Seat {entry.name}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Guests</label>
            <input className={input} type="number" min={1} value={covers} onChange={(e) => setCovers(e.target.value)} />
          </div>
          <div>
            <label className={label}>Table</label>
            <select className={input} value={tableId} onChange={(e) => setTableId(e.target.value)}>
              {tables.map((t) => (
                <option key={t.id} value={t.id} disabled={t.occupied}>
                  {t.name}
                  {t.occupied ? ' — occupied' : ''}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            onClick={() => submit(false)}
            disabled={pending || !tableId || !Number.isInteger(n) || n < 1}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />} Seat party
          </button>
          {conflict && (
            <button onClick={() => submit(true)} disabled={pending} className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
              Seat anyway
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function WaitlistView({
  branchId,
  entries,
  tables,
}: {
  branchId: string
  entries: WaitlistItem[]
  tables: WaitlistTable[]
}) {
  const router = useRouter()
  const [now, setNow] = useState(() => Date.now())
  const [adding, setAdding] = useState(false)
  const [seating, setSeating] = useState<WaitlistItem | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
      router.refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [router])

  const rows = entries.map((e) => ({ ...e, createdDate: new Date(e.createdAt) }))
  const summary = waitlistSummary(rows.map((r) => ({ createdAt: r.createdDate })), new Date(now))
  const freeCount = tables.filter((t) => !t.occupied).length

  function notify(e: WaitlistItem) {
    start(async () => {
      const r = await notifyWaitlistParty(e.id)
      if (r.error) {
        toast.error(r.error)
        return
      }
      if (r.delivery === 'sent') toast.success(`Texted ${e.name}.`)
      else if (r.whatsappUrl) {
        // No SMS provider yet — open the click-to-chat message instead.
        toast.message(`${e.name} marked notified. SMS isn’t set up, opening WhatsApp…`)
        window.open(r.whatsappUrl, '_blank', 'noopener,noreferrer')
      } else toast.message(`${e.name} marked notified. No phone on file — call them over.`)
      router.refresh()
    })
  }

  function leave(e: WaitlistItem) {
    if (!window.confirm(`Remove ${e.name} from the waitlist?`)) return
    start(async () => {
      const r = await removeFromWaitlist(e.id)
      if (r.error) toast.error(r.error)
      else router.refresh()
    })
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Waitlist</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.count === 0
              ? 'Nobody waiting'
              : `${summary.count} waiting · longest ${summary.longestMinutes} min`}{' '}
            · {freeCount} {freeCount === 1 ? 'table' : 'tables'} free
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus size={15} /> Add party
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          The waitlist is empty.
        </div>
      ) : (
        <ul className="mt-5 space-y-2.5">
          {rows.map((r, i) => {
            const waited = waitedMinutes(r.createdDate, new Date(now))
            const over = isOverQuote(r.quotedWaitMinutes, r.createdDate, new Date(now))
            const notified = r.status === 'notified'
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="w-8 text-lg font-semibold tabular-nums text-muted-foreground">{i + 1}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    {notified && <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">Notified</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><Users size={13} /> {r.partySize}</span>
                    <span className={over ? 'font-medium text-amber-600' : ''}>
                      waited {waited}m{r.quotedWaitMinutes !== null ? ` / quoted ${r.quotedWaitMinutes}m` : ''}
                    </span>
                    {r.phone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {r.phone}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => notify(r)}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {r.phone ? <MessageCircle size={14} /> : <BellRing size={14} />}
                    {notified ? 'Notify again' : 'Notify'}
                  </button>
                  <button
                    onClick={() => setSeating(r)}
                    disabled={pending}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Seat
                  </button>
                  <button
                    onClick={() => leave(r)}
                    disabled={pending}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    Left
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {adding && (
        <AddDialog
          branchId={branchId}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            toast.success('Added to the waitlist.')
            router.refresh()
          }}
        />
      )}
      {seating && (
        <SeatDialog
          entry={seating}
          tables={tables}
          onClose={() => setSeating(null)}
          onSeated={() => {
            setSeating(null)
            toast.success(`${seating.name} seated.`)
            router.push('/floor')
          }}
        />
      )}
    </div>
  )
}
