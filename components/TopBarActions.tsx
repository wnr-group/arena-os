'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, ChevronDown, CircleUserRound, LogOut, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'
import { listActiveWalkinsForAlarm, type ActiveWalkinAlarmRow } from '@/lib/actions/bookings'
import { ALARM_SOUND_DATA_URI } from '@/lib/booking/alarmSound'
import { cn } from '@/lib/utils/cn'

const POLL_INTERVAL_MS = 60_000
/** Same key SessionsBoard used to own — kept so an operator's existing
 *  "sound enabled" choice carries over now that this lives in the top bar. */
const SOUND_PREF_KEY = 'arena.sessions.soundEnabled'

/** Bookings currently inside their heads-up window, persisted across page
 *  loads — without this, headsUpRef started empty on every mount, so a
 *  booking that had already been alerted for (page open earlier, or a
 *  previous visit) rang the chime again on every reload, not just the one
 *  genuine crossing. */
const ALERTED_STORAGE_KEY = 'arena.sessions.headsUpAlertedIds'

function loadAlertedIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(ALERTED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveAlertedIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(ALERTED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Storage full/unavailable (private browsing) — the alarm still works
    // for this tab, it just loses the "don't repeat" memory across reloads.
  }
}

function isCheckedOut(s: ActiveWalkinAlarmRow): boolean {
  return s.billingMode === 'open_tab' ? s.endsAt !== null : Number(s.slotTotal) > 0
}

/**
 * The dashboard top bar's right-hand cluster: a notification bell
 * (placeholder — no behavior yet), the global walk-in heads-up alarm — it
 * chimes warningMinutes before a timed session ends (5 min by default),
 * not at the moment it actually ends, so staff have time to act — relocated
 * off the Sessions page so it fires from anywhere in the app, not just
 * while that one page is open, and the account/profile menu.
 *
 * The alarm polls the same active-walk-ins read SessionsBoard uses, but
 * independently — SessionsBoard keeps its own per-card countdown/visuals for
 * when you're actually on /sessions, it just no longer touches audio, so the
 * two can never double-fire the same beep while both happen to be mounted.
 */
export function TopBarActions({
  userFullName,
  userEmail,
  roleLabel,
  signOutAction,
  walkinsEnabled,
  branchId,
}: {
  userFullName: string | null
  userEmail: string
  roleLabel: string
  signOutAction: () => void | Promise<void>
  /** Same canManageWalkins/non-restaurant gate as the Sessions nav entry —
   *  a tenant/role with no walk-ins has nothing for this to poll. */
  walkinsEnabled: boolean
  /** Null when walkinsEnabled is false, or no primary branch is configured. */
  branchId: string | null
}) {
  const router = useRouter()
  const active = walkinsEnabled && branchId !== null

  // ── sound toggle + unlock ────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [soundEnabled, setSoundEnabled] = useState(false)
  // Read inside tick() instead of the `soundEnabled` state directly — state
  // loads from localStorage a tick after mount, and the poll effect below
  // doesn't depend on it, so without this a tick that runs before that load
  // resolves would see a stale `false`, skip the chime, but still mark the
  // booking as alerted — silently eating the one alarm this crossing was
  // ever going to get.
  const soundEnabledRef = useRef(false)
  useEffect(() => {
    soundEnabledRef.current = soundEnabled
  }, [soundEnabled])
  useEffect(() => {
    setSoundEnabled(typeof window !== 'undefined' && window.localStorage.getItem(SOUND_PREF_KEY) === '1')
  }, [])

  function toggleSound() {
    if (soundEnabled) {
      setSoundEnabled(false)
      window.localStorage.setItem(SOUND_PREF_KEY, '0')
      return
    }
    const audio = audioRef.current
    if (!audio) return
    // Unlock trick: play+immediately pause in direct response to this click
    // (a real user gesture) so the browser's autoplay policy lets a LATER,
    // gesture-less .play() call (from the poll tick) actually make sound.
    audio
      .play()
      .then(() => {
        audio.pause()
        audio.currentTime = 0
        setSoundEnabled(true)
        window.localStorage.setItem(SOUND_PREF_KEY, '1')
      })
      .catch(() => setSoundEnabled(false))
  }

  // ── poll + alarm ─────────────────────────────────────────────────────
  const alarmedRef = useRef<Set<string>>(new Set())
  // Tracks bookings whose heads-up toast + chime have already fired, seeded
  // from localStorage (see loadAlertedIds) so a page reload doesn't treat an
  // already-alerted booking as a fresh crossing. A session passes through
  // this set on its way to becoming alarmed, never re-firing once it's
  // inside the window — until it's extended back out and re-enters later.
  const headsUpRef = useRef<Set<string>>(loadAlertedIds())
  const [alarmedCount, setAlarmedCount] = useState(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick() {
      const { sessions } = await listActiveWalkinsForAlarm(branchId!)
      if (cancelled) return
      const now = Date.now()
      const stillAlarmed = new Set<string>()
      const stillHeadsUp = new Set<string>()
      for (const s of sessions) {
        if (s.billingMode !== 'timed' || !s.endsAt || isCheckedOut(s)) continue
        const remaining = new Date(s.endsAt).getTime() - now
        const label = s.customerName || s.customerPhone || 'Walk-in'
        if (remaining <= 0) {
          stillAlarmed.add(s.bookingId)
          if (!alarmedRef.current.has(s.bookingId)) {
            toast.error(`Time's up — ${s.resourceName} (${label})`, {
              action: { label: 'View sessions', onClick: () => router.push('/sessions') },
            })
          }
          continue
        }
        if (remaining <= s.warningMinutes * 60_000) {
          stillHeadsUp.add(s.bookingId)
          if (!headsUpRef.current.has(s.bookingId)) {
            // The chime rings HERE — warningMinutes before the session ends
            // (5 min by default) — not at the moment it actually ends. That
            // gives staff time to act instead of finding out only once it's
            // already over.
            if (soundEnabledRef.current) {
              audioRef.current?.play().catch(() => {})
            }
            toast.warning(`${s.warningMinutes} min left — ${s.resourceName} (${label})`, {
              action: { label: 'View sessions', onClick: () => router.push('/sessions') },
            })
          }
        }
      }
      alarmedRef.current = stillAlarmed
      // A booking that's since been extended past the warning window drops
      // back out of stillHeadsUp, so re-crossing it later fires again.
      headsUpRef.current = stillHeadsUp
      saveAlertedIds(stillHeadsUp)
      setAlarmedCount(stillAlarmed.size)
    }

    tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // soundEnabled deliberately excluded — see soundEnabledRef's own comment
    // above; restarting this poll on every toggle would re-run tick()
    // immediately with a build-up risk of the same stale-read race.
  }, [active, branchId, router])

  // ── profile dropdown ─────────────────────────────────────────────────
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!profileOpen) return
    function onDown(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setProfileOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [profileOpen])

  const displayName = userFullName?.trim() || userEmail

  return (
    <div className="flex items-center gap-1">
      {active && <audio ref={audioRef} src={ALARM_SOUND_DATA_URI} preload="auto" />}

      {/* Notifications — placeholder, no behavior yet. */}
      <button
        type="button"
        title="Notifications"
        aria-label="Notifications"
        className="rounded-lg p-2 text-accent-foreground/60 transition hover:bg-[rgba(139,34,66,0.07)] hover:text-primary"
      >
        <Bell size={18} />
      </button>

      {active && (
        <button
          type="button"
          onClick={toggleSound}
          title={soundEnabled ? 'Session alarm sound on' : 'Enable session alarm sound'}
          aria-label={soundEnabled ? 'Session alarm sound on' : 'Enable session alarm sound'}
          className={cn(
            'relative rounded-lg p-2 transition',
            alarmedCount > 0
              ? 'text-destructive hover:bg-destructive/10'
              : soundEnabled
                ? 'text-emerald-600 hover:bg-emerald-500/10'
                : 'text-accent-foreground/60 hover:bg-[rgba(139,34,66,0.07)] hover:text-primary',
          )}
        >
          {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
          {alarmedCount > 0 && (
            <span className="absolute right-1 top-1 flex size-2 animate-pulse rounded-full bg-destructive" />
          )}
        </button>
      )}

      <div className="relative" ref={profileRef}>
        <button
          type="button"
          onClick={() => setProfileOpen((v) => !v)}
          aria-expanded={profileOpen}
          className="flex items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 transition hover:bg-[rgba(139,34,66,0.07)]"
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CircleUserRound size={18} strokeWidth={2} />
          </div>
          <span className="hidden max-w-[140px] truncate text-sm font-medium text-foreground sm:inline">
            {displayName}
          </span>
          <ChevronDown size={14} className={cn('hidden text-accent-foreground/60 transition-transform sm:inline', profileOpen && 'rotate-180')} />
        </button>
        {profileOpen && (
          <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-border bg-card p-3 shadow-xl">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <CircleUserRound size={20} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
              </div>
            </div>
            <p className="mt-2 text-[11px] font-medium text-muted-foreground">{roleLabel}</p>
            <form action={signOutAction} className="mt-3">
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <LogOut size={15} /> Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
