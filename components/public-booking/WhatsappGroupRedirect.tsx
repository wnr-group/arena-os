'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import {
  shouldAutoRedirectToWhatsapp,
  WHATSAPP_REDIRECT_SECONDS,
} from '@/lib/settings/whatsapp-group'

/**
 * The post-booking WhatsApp group nudge: a countdown, then an automatic
 * redirect, with a button that always works.
 *
 * Rendered by BookingConfirmation ONLY when the venue has the feature on and a
 * valid invite, so this component never reasons about the disabled case. It
 * plays no part in creating the booking either: by the time it mounts the
 * booking is committed and its confirmation page is being read back by token.
 *
 * ══ THE BUTTON AND THE COUNTDOWN ARE DIFFERENT PROMISES ═════════════════════
 *
 * The BUTTON is unconditional. Whenever this component renders, joining is one
 * tap — that is the whole fallback, and nothing below may take it away.
 *
 * The COUNTDOWN is conditional, and deliberately hard to arm.
 * shouldAutoRedirectToWhatsapp() (lib/settings/whatsapp-group.ts) states the
 * four conditions and why each exists; the short version is that /b/[token] is
 * also the check-in QR page and is reachable long after the booking, so
 * "somebody is looking at this page" is not the same as "somebody just
 * booked". Only the booking flow's own hand-off says the latter, with ?new=1.
 *
 * ══ WHY href AND NOT window.open ════════════════════════════════════════════
 *
 * A popup opened without a user gesture — which a timer expiring is not — is
 * blocked by every current browser, silently. A same-tab navigation is not.
 */
export function WhatsappGroupRedirect({
  url,
  storageKey,
  fromNewBooking,
  awaitingPayment,
  seconds = WHATSAPP_REDIRECT_SECONDS,
}: {
  /** Already validated server-side; see lib/booking/public-whatsapp.ts. */
  url: string
  /** Per-booking, so Back cannot re-trigger this booking's countdown. */
  storageKey: string
  /** True only on the hand-off straight from a completed booking (?new=1). */
  fromNewBooking: boolean
  /** True while the venue is still owed a deposit — see PublicBookingConfirmation. */
  awaitingPayment: boolean
  seconds?: number
}) {
  // null = no countdown: never armed, already spent, or cancelled by the button.
  const [remaining, setRemaining] = useState<number | null>(null)
  // Starts true so the first tick is not blocked before the listener attaches;
  // the effect below corrects it immediately on mount.
  const [visible, setVisible] = useState(true)

  const markSpent = useCallback(() => {
    try {
      sessionStorage.setItem(storageKey, '1')
    } catch {
      // Private mode. The navigation still happens, and the back_forward check
      // below is what stops the loop this would otherwise leave behind.
    }
  }, [storageKey])

  const leave = useCallback(() => {
    markSpent()
    window.location.href = url
  }, [markSpent, url])

  // ── arm, once, on mount ───────────────────────────────────────────────────
  //
  // An effect rather than a lazy initial state: sessionStorage and performance
  // do not exist during server rendering, and reading them in an initialiser
  // would make the first client render disagree with the server's HTML.
  useEffect(() => {
    let alreadySpent = false
    try {
      alreadySpent = sessionStorage.getItem(storageKey) === '1'
    } catch {
      alreadySpent = false
    }

    // The storage-independent half of the Back guard. Wrapped because the
    // Navigation Timing entry is absent in some embedded browsers, and a
    // missing entry must not be read as "this is a fresh visit" — but it also
    // must not block a genuine one, so absence falls back to false and
    // sessionStorage carries the guard alone.
    let backForward = false
    try {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      backForward = nav?.type === 'back_forward'
    } catch {
      backForward = false
    }

    if (shouldAutoRedirectToWhatsapp({ fromNewBooking, awaitingPayment, alreadySpent, backForward })) {
      setRemaining(seconds)
    }
  }, [seconds, storageKey, fromNewBooking, awaitingPayment])

  // ── pause while the tab is hidden ─────────────────────────────────────────
  //
  // Browsers throttle timers in background tabs but still RUN them, so without
  // this a customer who switches tabs mid-countdown comes back to WhatsApp with
  // the booking page already gone. Pausing means the countdown they watch is
  // the countdown that fires.
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // One tick. A self-rescheduling timeout rather than an interval, so cleanup is
  // the whole story: unmount, a route change, or the tab hiding clears the only
  // pending timer there is.
  useEffect(() => {
    if (!visible || remaining === null || remaining <= 0) return
    const id = setTimeout(() => setRemaining((n) => (n === null ? null : n - 1)), 1000)
    return () => clearTimeout(id)
  }, [remaining, visible])

  // The navigation itself, kept out of the tick so nothing side-effecting runs
  // inside a state updater. Gated on `visible` too: never navigate a tab the
  // customer is not looking at.
  useEffect(() => {
    if (visible && remaining === 0) leave()
  }, [remaining, visible, leave])

  const counting = remaining !== null && remaining > 0

  return (
    <div className="mt-6 rounded-2xl border border-[#25D366]/30 bg-[#25D366]/5 p-5 text-center shadow-sm">
      <p className="text-sm font-semibold text-foreground">
        Your booking is confirmed successfully.
      </p>

      {/* aria-live so a screen reader is told the redirect is coming rather than
          the page changing under it. Polite, not assertive: it must not
          interrupt the booking details being read. */}
      <p className="mt-1 min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {counting
          ? `Redirecting to WhatsApp group in ${remaining}...`
          : remaining === 0
            ? 'Taking you to WhatsApp…'
            : 'Join our WhatsApp group for updates and offers.'}
      </p>

      {/* Always rendered, whatever the countdown is doing — it is the fallback
          for a blocked redirect, the way off the page once the countdown is
          spent, and the ONLY affordance in every state where arming is refused.
          A real anchor, not a button calling location.href: it survives the
          countdown being cancelled, a click before hydration, and JavaScript
          failing entirely. The handler only cancels the timer and burns the Back
          guard — the navigation is the browser's. Same tab (no target). */}
      <a
        href={url}
        rel="noopener noreferrer"
        onClick={() => {
          setRemaining(null)
          markSpent()
        }}
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-semibold text-white shadow-md shadow-[#25D366]/20 transition hover:-translate-y-0.5 hover:brightness-95 hover:shadow-lg active:translate-y-0"
      >
        <MessageCircle size={16} aria-hidden /> Join WhatsApp Group
      </a>
    </div>
  )
}
