'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlarmClock, BellRing, Clock, ReceiptText, RefreshCw, Timer, Volume2, VolumeX } from 'lucide-react'
import { previewWalkinCheckout } from '@/lib/actions/bookings'
import { formatCountdown } from '@/lib/booking/countdown'
import { ALARM_SOUND_DATA_URI } from '@/lib/booking/alarmSound'
import { formatMoney, timeInZone } from '@/lib/format'
import { WalkinCheckoutDialog } from '@/components/bookings/WalkinCheckoutDialog'
import { TimedWalkinDialog } from '@/components/bookings/TimedWalkinDialog'

export type SessionRow = {
  bookingId: string
  bookingNumber: string
  customerName: string | null
  customerPhone: string | null
  resourceName: string
  resourceTypeName: string
  startsAt: string
  /** Null for a still-running open tab; the committed end (extensions
   *  included) for a timed session. */
  endsAt: string | null
  billingMode: 'open_tab' | 'timed'
  /** '0.00' until checkout prices the session. */
  slotTotal: string
  rateApplied: string
}

/** Heads-up fires once per session at the 5-minute mark; the alarm itself
 *  (sound + banner) fires once at zero and then just stays true until the
 *  operator handles it (extend resets both, checkout clears them). */
type AlarmState = { headsUp: boolean; alarmed: boolean }

const HEADS_UP_MS = 5 * 60_000
const REFRESH_INTERVAL_MS = 60_000
const SOUND_PREF_KEY = 'arena.sessions.soundEnabled'

/**
 * The live walk-in sessions board (M21 #6) — a card per active walk-in with
 * a live countdown/elapsed readout, a running total, and Extend/Checkout.
 * Owns the time's-up alarm for TIMED sessions (open tabs have no committed
 * end, so nothing to alarm on — they just show elapsed time).
 *
 * Everything here is derived, every tick, from `committed_end_at`/`starts_at`
 * strings the server sent down — there is no persisted client-side timer
 * state. That is what makes "closing every board tab never mis-bills, and
 * reopening recomputes from the server" true for free: a reload just re-runs
 * the same math against fresh props, and the actual money (extendWalkin/
 * checkoutWalkin) only ever gets written server-side, gated exactly like it
 * would be from the Bookings page's own Active Walk-ins panel.
 *
 * Client-side only for v1, per the design doc: a periodic router.refresh()
 * (REFRESH_INTERVAL_MS) is the only "sync" this has — no push/realtime.
 * Upgrading to server-pushed updates (M10) means replacing that poll with a
 * subscription that calls the same setSessions state setter; nothing about
 * the alarm logic, the dialogs, or the billing actions would need to change.
 */
export function SessionsBoard({
  branchName,
  timeZone,
  currency,
  sessions: initialSessions,
}: {
  branchName: string
  timeZone: string
  currency: string
  sessions: SessionRow[]
}) {
  const router = useRouter()
  const [sessions, setSessions] = useState(initialSessions)
  useEffect(() => setSessions(initialSessions), [initialSessions])

  useEffect(() => {
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [router])

  // Starts null (not Date.now()) on purpose: a 'use client' component is
  // still server-rendered for the initial HTML, and initializing this with
  // Date.now() would bake in the SERVER's instant — a different real-world
  // moment than the CLIENT's first render a beat later — producing a
  // guaranteed hydration mismatch on every countdown/elapsed string on the
  // board. Setting the real clock only inside an effect (client-only, after
  // hydration already matched null on both sides) avoids that; every
  // consumer below treats null as "not mounted yet" and renders a neutral
  // placeholder instead of computing from it.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  // ── sound unlock ────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [soundEnabled, setSoundEnabled] = useState(false)
  useEffect(() => {
    setSoundEnabled(typeof window !== 'undefined' && window.localStorage.getItem(SOUND_PREF_KEY) === '1')
  }, [])
  function enableSound() {
    const audio = audioRef.current
    if (!audio) return
    // The unlock trick: play+immediately pause in direct response to this
    // click (a real user gesture) so the browser's autoplay policy lets a
    // LATER, gesture-less .play() call (from the alarm tick) actually make
    // sound. If it still throws (blocked, or no supported audio backend),
    // the banner is the fallback — the alarm never depends on sound firing.
    audio
      .play()
      .then(() => {
        audio.pause()
        audio.currentTime = 0
        setSoundEnabled(true)
        window.localStorage.setItem(SOUND_PREF_KEY, '1')
      })
      .catch(() => {
        setSoundEnabled(false)
      })
  }

  // ── alarm state, per booking ────────────────────────────────────────────
  const [alarms, setAlarms] = useState<Record<string, AlarmState>>({})
  const resetAlarm = useCallback((bookingId: string) => {
    setAlarms((prev) => ({ ...prev, [bookingId]: { headsUp: false, alarmed: false } }))
  }, [])
  const clearAlarm = useCallback((bookingId: string) => {
    setAlarms((prev) => {
      if (!(bookingId in prev)) return prev
      const next = { ...prev }
      delete next[bookingId]
      return next
    })
  }, [])

  // One effect, ticking off `now`, decides whether each timed session needs
  // its heads-up or its alarm raised — the single place either ever fires,
  // so each can only ever happen once per arm (extend re-arms by resetting
  // the flags above).
  useEffect(() => {
    if (now === null) return
    for (const s of sessions) {
      if (s.billingMode !== 'timed' || !s.endsAt || isCheckedOut(s)) continue
      const remaining = new Date(s.endsAt).getTime() - now
      setAlarms((prev) => {
        const state = prev[s.bookingId] ?? { headsUp: false, alarmed: false }
        if (remaining <= 0 && !state.alarmed) {
          if (soundEnabled) audioRef.current?.play().catch(() => {})
          return { ...prev, [s.bookingId]: { headsUp: true, alarmed: true } }
        }
        if (remaining > 0 && remaining <= HEADS_UP_MS && !state.headsUp) {
          return { ...prev, [s.bookingId]: { ...state, headsUp: true } }
        }
        return prev
      })
    }
  }, [now, sessions, soundEnabled])

  const alarmedSessions = useMemo(
    () => sessions.filter((s) => alarms[s.bookingId]?.alarmed && !isCheckedOut(s)),
    [sessions, alarms],
  )

  const [checkoutTarget, setCheckoutTarget] = useState<SessionRow | null>(null)
  const [timedTarget, setTimedTarget] = useState<SessionRow | null>(null)

  function openManage(s: SessionRow) {
    if (s.billingMode === 'open_tab') setCheckoutTarget(s)
    else setTimedTarget(s)
  }

  return (
    <div className="px-6 py-6">
      <audio ref={audioRef} src={ALARM_SOUND_DATA_URI} preload="auto" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <AlarmClock size={22} /> Sessions
          </h1>
          <p className="text-sm text-muted-foreground">{branchName} · live walk-ins</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.refresh()}
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition hover:bg-accent/70"
          >
            <RefreshCw size={15} /> Refresh
          </button>
          <button
            onClick={enableSound}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition ${
              soundEnabled
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                : 'border-border bg-card hover:bg-muted'
            }`}
          >
            {soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
            {soundEnabled ? 'Sound on' : 'Enable sound'}
          </button>
        </div>
      </div>

      {!soundEnabled && (
        <p className="mt-3 text-xs text-muted-foreground">
          Sound is off on this device — the time&apos;s-up banner below will still appear, just silently. Click
          &quot;Enable sound&quot; once to arm the alarm.
        </p>
      )}

      {/* persistent time's-up banner — stays until each session is extended or checked out */}
      {alarmedSessions.length > 0 && (
        <div className="mt-4 space-y-2">
          {alarmedSessions.map((s) => (
            <div
              key={s.bookingId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <BellRing size={16} className="animate-pulse" />
                Time&apos;s up — {s.resourceName} ({s.customerName || s.customerPhone || 'Walk-in'})
              </span>
              <button
                onClick={() => openManage(s)}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
              >
                Extend / check out
              </button>
            </div>
          ))}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">No active walk-ins right now.</p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard
              key={s.bookingId}
              session={s}
              now={now}
              timeZone={timeZone}
              currency={currency}
              alarmed={Boolean(alarms[s.bookingId]?.alarmed)}
              onManage={() => openManage(s)}
            />
          ))}
        </div>
      )}

      {checkoutTarget && (
        <WalkinCheckoutDialog
          booking={checkoutTarget}
          timeZone={timeZone}
          currency={currency}
          onClose={() => setCheckoutTarget(null)}
        />
      )}
      {timedTarget && timedTarget.endsAt && (
        <TimedWalkinDialog
          booking={{ ...timedTarget, committedEndAt: timedTarget.endsAt }}
          timeZone={timeZone}
          currency={currency}
          onClose={() => {
            // Whether this was an extend (re-arm) or a checkout (resolved),
            // the old alarm no longer applies to whatever's true now — a
            // fresh reload of this exact math (via router.refresh below)
            // will re-raise it if it's still genuinely overdue.
            resetAlarm(timedTarget.bookingId)
            clearAlarm(timedTarget.bookingId)
            setTimedTarget(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function isCheckedOut(s: SessionRow): boolean {
  return s.billingMode === 'open_tab' ? s.endsAt !== null : Number(s.slotTotal) > 0
}

function SessionCard({
  session: s,
  now,
  timeZone,
  currency,
  alarmed,
  onManage,
}: {
  session: SessionRow
  /** Null until mounted — see SessionsBoard's own doc comment on why `now`
   *  starts null rather than Date.now(). */
  now: number | null
  timeZone: string
  currency: string
  alarmed: boolean
  onManage: () => void
}) {
  const checkedOut = isCheckedOut(s)
  const [runningTotal, setRunningTotal] = useState<number | null>(checkedOut ? Number(s.slotTotal) : null)

  // Re-priced periodically while the session is still live — the same
  // previewWalkinCheckout call the checkout dialogs themselves use, so the
  // "running total" shown here is never a client-side approximation that
  // could disagree with what actually gets billed.
  useEffect(() => {
    if (checkedOut) {
      setRunningTotal(Number(s.slotTotal))
      return
    }
    if (now === null) return
    let cancelled = false
    previewWalkinCheckout({ bookingId: s.bookingId }).then((r) => {
      if (!cancelled && r.total !== undefined) setRunningTotal(r.total)
    })
    return () => {
      cancelled = true
    }
    // Ticks with the shared 1s clock, but only actually refetches every ~20s
    // via the modulo below — a per-second server round trip per card would
    // be wasteful for a number that only matters to the nearest few rupees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.bookingId, checkedOut, now === null ? null : Math.floor(now / 20_000)])

  const elapsedOrCountdown =
    now === null
      ? { text: '—', overdue: false }
      : s.billingMode === 'timed' && s.endsAt && !checkedOut
        ? formatCountdown(s.endsAt, now)
        : { text: elapsedText(s.startsAt, now), overdue: false }

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition ${
        alarmed ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{s.resourceName}</p>
          <p className="truncate text-xs text-muted-foreground">{s.resourceTypeName}</p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            s.billingMode === 'timed' ? 'bg-primary/10 text-primary' : 'bg-accent text-accent-foreground'
          }`}
        >
          {s.billingMode === 'timed' ? <Timer size={11} /> : <Clock size={11} />}
          {s.billingMode === 'timed' ? 'Timed' : 'Open tab'}
        </span>
      </div>

      <p className="mt-2 truncate text-sm text-foreground">{s.customerName || s.customerPhone || 'Walk-in'}</p>
      <p className="text-xs text-muted-foreground">Started {timeInZone(s.startsAt, timeZone)}</p>

      <div
        className={`mt-3 flex items-center justify-between rounded-lg border px-3 py-2 ${
          elapsedOrCountdown.overdue ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-accent/40'
        }`}
      >
        <span
          className={`flex items-center gap-1.5 text-sm font-semibold ${
            elapsedOrCountdown.overdue ? 'text-destructive' : 'text-foreground'
          }`}
        >
          <Clock size={14} /> {checkedOut ? 'Checked out' : elapsedOrCountdown.text}
        </span>
        {s.billingMode === 'timed' && s.endsAt && !checkedOut && (
          <span className="text-xs text-muted-foreground">Ends {timeInZone(s.endsAt, timeZone)}</span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{checkedOut ? 'Billed' : 'Running total'}</span>
        <span className="text-base font-bold tabular-nums text-foreground">
          {runningTotal === null ? '—' : formatMoney(runningTotal, currency)}
        </span>
      </div>

      {checkedOut ? (
        <a
          href={`/pos/${s.bookingId}`}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <ReceiptText size={15} /> Pay
        </a>
      ) : (
        <button
          onClick={onManage}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {s.billingMode === 'open_tab' ? (
            <>
              <ReceiptText size={15} /> Close tab
            </>
          ) : (
            <>
              <Timer size={15} /> Extend / check out
            </>
          )}
        </button>
      )}
    </div>
  )
}

/** "1h 12m" elapsed since `startIso` — same clock/hour shape formatCountdown
 *  uses, just counting up instead of down (an open tab has nothing to count
 *  down to). */
function elapsedText(startIso: string, nowMs: number): string {
  const totalMin = Math.max(0, Math.round((nowMs - new Date(startIso).getTime()) / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m elapsed` : `${m}m elapsed`
}
