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

function isCheckedOut(s: ActiveWalkinAlarmRow): boolean {
  return s.billingMode === 'open_tab' ? s.endsAt !== null : Number(s.slotTotal) > 0
}

/**
 * The dashboard top bar's right-hand cluster: a notification bell
 * (placeholder — no behavior yet), the global walk-in time's-up alarm
 * (relocated off the Sessions page so it fires from anywhere in the app,
 * not just while that one page is open), and the account/profile menu.
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
  const [alarmedCount, setAlarmedCount] = useState(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick() {
      const { sessions } = await listActiveWalkinsForAlarm(branchId!)
      if (cancelled) return
      const now = Date.now()
      const stillAlarmed = new Set<string>()
      for (const s of sessions) {
        if (s.billingMode !== 'timed' || !s.endsAt || isCheckedOut(s)) continue
        if (new Date(s.endsAt).getTime() > now) continue
        stillAlarmed.add(s.bookingId)
        if (!alarmedRef.current.has(s.bookingId)) {
          if (soundEnabled) audioRef.current?.play().catch(() => {})
          toast.error(`Time's up — ${s.resourceName} (${s.customerName || s.customerPhone || 'Walk-in'})`, {
            action: { label: 'View sessions', onClick: () => router.push('/sessions') },
          })
        }
      }
      alarmedRef.current = stillAlarmed
      setAlarmedCount(stillAlarmed.size)
    }

    tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active, branchId, soundEnabled, router])

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
