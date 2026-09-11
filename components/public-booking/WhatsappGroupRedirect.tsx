'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { getBookingPaymentState } from '@/lib/actions/public-booking'
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
 * ══ WHY THE DEPOSIT IS RE-ASKED (0107) ══════════════════════════════════════
 *
 * `awaitingPayment` arrives as a server-rendered fact, and for an ONLINE
 * payment that fact is stale before the page paints. Razorpay's browser
 * callback navigates here the instant payment is submitted; the only thing
 * that marks the deposit settled is the verified webhook landing
 * server-to-server a moment later (lib/payments/webhook.ts). So the first
 * render almost always says "still owed".
 *
 * Nothing used to re-ask, which meant the countdown never armed for any
 * customer who paid online — the exact case the feature exists for. It failed
 * SAFE (never an early redirect), but it also failed silently.
 *
 * So when the page loads armed-but-unpaid, this polls getBookingPaymentState()
 * until the webhook lands or the window closes. The authority is unchanged: the
 * answer still comes from a `paid` payment intent carrying a gateway payment
 * id, never from the Razorpay callback, and any error keeps the countdown
 * unarmed.
 *
 * ══ WHY href AND NOT window.open ════════════════════════════════════════════
 *
 * A popup opened without a user gesture — which a timer expiring is not — is
 * blocked by every current browser, silently. A same-tab navigation is not.
 */

/** How long to wait for the webhook before giving up and leaving the button. */
const PAYMENT_POLL_INTERVAL_MS = 2_500
const PAYMENT_POLL_ATTEMPTS = 24 // ≈60s, comfortably past a normal webhook.

export function WhatsappGroupRedirect({
  url,
  storageKey,
  confirmationToken,
  fromNewBooking,
  awaitingPayment,
  headline,
  seconds = WHATSAPP_REDIRECT_SECONDS,
}: {
  /** Already validated server-side; see lib/booking/public-whatsapp.ts. */
  url: string
  /** Per-booking, so Back cannot re-trigger this booking's countdown. */
  storageKey: string
  /** The /b/[token] route param, so the deposit can be re-asked. */
  confirmationToken: string
  /** True only on the hand-off straight from a completed booking (?new=1). */
  fromNewBooking: boolean
  /** Server-rendered, and re-checked below while it stays true. */
  awaitingPayment: boolean
  /** Status-appropriate copy — a finished visit is not "confirmed". */
  headline: string
  seconds?: number
}) {
  // null = no countdown: never armed, already spent, or cancelled by the button.
  const [remaining, setRemaining] = useState<number | null>(null)
  // Starts true so the first tick is not blocked before the listener attaches;
  // the effect below corrects it immediately on mount.
  const [visible, setVisible] = useState(true)
  // Server-rendered seed, then whatever polling learns.
  const [awaiting, setAwaiting] = useState(awaitingPayment)
  // The two browser facts, read once on mount. Null until then, which is what
  // keeps arming out of the first render where they cannot be known.
  const [browserGuard, setBrowserGuard] = useState<{
    alreadySpent: boolean
    backForward: boolean
  } | null>(null)

  // Refs, not state: these must be readable by an effect that should NOT re-run
  // when they change. `spent` also has to survive the button's own click, which
  // cancels the countdown in the same tick it marks the guard.
  const spentRef = useRef(false)
  const armedRef = useRef(false)

  const markSpent = useCallback(() => {
    spentRef.current = true
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

  // ── read the browser's two facts, once, on mount ──────────────────────────
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

    if (alreadySpent) spentRef.current = true
    setBrowserGuard({ alreadySpent, backForward })
  }, [storageKey])

  // ── arm, once, when every condition finally holds ─────────────────────────
  //
  // Re-evaluated rather than decided on mount, because `awaiting` can still
  // turn false later — that is the whole point of the polling below. `armedRef`
  // makes it a one-way door: a countdown that was started and then cancelled by
  // the button must never restart.
  useEffect(() => {
    if (!browserGuard || armedRef.current || spentRef.current) return
    if (
      shouldAutoRedirectToWhatsapp({
        fromNewBooking,
        awaitingPayment: awaiting,
        alreadySpent: browserGuard.alreadySpent,
        backForward: browserGuard.backForward,
      })
    ) {
      armedRef.current = true
      setRemaining(seconds)
    }
  }, [browserGuard, awaiting, fromNewBooking, seconds])

  // ── wait for the webhook, but not forever ─────────────────────────────────
  //
  // Only runs in the one situation that needs it: a fresh hand-off whose
  // deposit has not settled yet. Every other state either armed already or is
  // refused for a reason polling cannot change, so no other visitor to this
  // page costs a single request.
  useEffect(() => {
    if (!browserGuard) return
    if (!fromNewBooking || !awaiting) return
    if (browserGuard.alreadySpent || browserGuard.backForward || spentRef.current) return

    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      if (cancelled) return
      attempts++
      try {
        const r = await getBookingPaymentState(confirmationToken)
        if (cancelled) return
        // Only a definite "settled" changes anything. An error — offline, rate
        // limited, a bad token — leaves `awaiting` true, so the countdown stays
        // unarmed and the button carries the page. Failing closed is the whole
        // reason this is safe to poll at all.
        if ('awaitingPayment' in r && r.awaitingPayment === false) {
          setAwaiting(false)
          return
        }
      } catch {
        // Same as an error result: keep waiting, never assume paid.
      }
      if (!cancelled && attempts < PAYMENT_POLL_ATTEMPTS) {
        timer = setTimeout(poll, PAYMENT_POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(poll, PAYMENT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [browserGuard, fromNewBooking, awaiting, confirmationToken])

  // ── pause while the tab is hidden ─────────────────────────────────────────
  //
  // Browsers throttle timers in background tabs but still RUN them, so without
  // this a customer who switches tabs mid-countdown comes back to WhatsApp with
  // the booking page already gone. Pausing means the countdown they watch is
  // the countdown that fires — the value FREEZES while hidden rather than
  // draining, because the tick effect's cleanup clears the pending timer.
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
  // Only while there is genuinely something to wait for — never on the check-in
  // QR visit, where no countdown was ever coming.
  const settling = fromNewBooking && awaiting && remaining === null

  return (
    <div className="mt-6 rounded-2xl border border-[#25D366]/30 bg-[#25D366]/5 p-5 text-center shadow-sm">
      <p className="text-sm font-semibold text-foreground">{headline}</p>

      {/* aria-live so a screen reader is told the redirect is coming rather than
          the page changing under it. Polite, not assertive: it must not
          interrupt the booking details being read. */}
      <p className="mt-1 min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {counting
          ? `Redirecting to WhatsApp group in ${remaining}...`
          : remaining === 0
            ? 'Taking you to WhatsApp…'
            : settling
              ? 'Confirming your payment…'
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
