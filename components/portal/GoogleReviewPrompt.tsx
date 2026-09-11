'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { Star, X } from 'lucide-react'
import { confirmGoogleReviewLeft } from '@/lib/actions/customer-review'

/**
 * The Google review ask, shown once per portal visit to an eligible customer.
 *
 * Mounted ONCE, by the portal layout. That placement is the whole frequency
 * story and is why no page needs to know this exists:
 *
 *   * a layout does not remount as the customer moves between /account,
 *     /account/bookings and /account/wallet, so the prompt appears when they
 *     ENTER the portal rather than on every navigation inside it;
 *   * it does remount on a fresh visit, which is exactly when it should ask
 *     again.
 *
 * Whether to render it at all is decided on the SERVER (lib/portal/review-
 * prompt.ts). By the time this component exists, the venue has enabled the
 * feature, the link has been validated twice, the customer is eligible, and
 * they have not already answered. There is nothing here to get wrong.
 *
 * ══ "MAYBE LATER" IS NOT AN ANSWER ══════════════════════════════════════════
 *
 * Dismissing closes the dialog for THIS visit only — it is remembered in
 * sessionStorage, not on the server, so it dies with the tab. The customer is
 * asked again next time, which is the requirement: the prompt persists until
 * the review requirement is actually completed.
 *
 * sessionStorage rather than nothing, because without it a client re-render
 * would pop the dialog straight back up in the same visit; and rather than
 * localStorage, because localStorage would quietly make "Maybe later" permanent
 * on that device.
 *
 * ══ WHAT "DONE" MEANS ══════════════════════════════════════════════════════
 *
 * Clicking through to Google does NOT complete the prompt. Google gives no
 * per-customer submission signal, so the only honest completion is the customer
 * telling us — which is the second step below, shown after they return. A
 * customer who opens Google and never reviews keeps being asked; a customer who
 * says they reviewed is believed and never asked again.
 */
export function GoogleReviewPrompt({
  url,
  venueName,
  customerId,
}: {
  url: string
  venueName: string
  /** Scopes the dismissal memory to this customer — see the key below. */
  customerId: string
}) {
  const [open, setOpen] = useState(false)
  // Set once they have been sent to Google, so the ask becomes "did you?"
  const [returned, setReturned] = useState(false)
  const [pending, start] = useTransition()
  const dialogRef = useRef<HTMLDivElement>(null)
  // Restored when the dialog closes, so focus does not jump to the top of the
  // page for a keyboard user who was part-way down it.
  const openerRef = useRef<Element | null>(null)

  // Per CUSTOMER, not a constant (0107). Two people signing in from the same
  // browser tab used to share one dismissal, so the second was never asked.
  // Not a cross-tenant leak — subdomains are separate origins — but it did
  // silence the prompt for the wrong person.
  const key = `google-review-prompt-dismissed:${customerId}`

  // Opened from an effect, not from initial state: sessionStorage does not
  // exist during server rendering, and reading it in an initialiser would make
  // the first client render disagree with the server's HTML.
  useEffect(() => {
    let dismissed = false
    try {
      dismissed = sessionStorage.getItem(key) === '1'
    } catch {
      // Private mode. Worst case the customer sees the ask once more this
      // visit, which is the behaviour the requirement asks for anyway.
      dismissed = false
    }
    if (!dismissed) setOpen(true)
  }, [key])

  const dismissForThisVisit = useCallback(() => {
    try {
      sessionStorage.setItem(key, '1')
    } catch {
      /* nothing to do — see above */
    }
    setOpen(false)
  }, [key])

  // ── what aria-modal promises, actually delivered (0107) ───────────────────
  //
  // This dialog already declared role="dialog" aria-modal="true", which tells a
  // screen reader the rest of the page is inert. Nothing enforced it: Escape
  // did nothing, Tab walked straight out into the page behind the overlay, and
  // closing dropped focus back to the top of the document. Those are the
  // behaviours a keyboard or screen-reader user is entitled to assume from that
  // markup, so they are implemented rather than the markup weakened.
  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement

    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )

    // Move focus INTO the dialog, so the next Tab is trapped rather than
    // continuing from wherever the customer happened to be on the page.
    focusables()[0]?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Escape is "maybe later", not "I reviewed": it must leave the prompt
        // pending for the next visit, exactly like the button does.
        dismissForThisVisit()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Only if focus is still inside the dialog — if the customer clicked
      // through to Google the browser has already moved on, and restoring
      // focus here would fight it.
      const opener = openerRef.current
      if (opener instanceof HTMLElement && dialogRef.current?.contains(document.activeElement)) {
        opener.focus()
      }
    }
  }, [open, returned, dismissForThisVisit])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="google-review-title"
    >
      {/* `relative` (0107): the close button is positioned `absolute`, and
          without a positioned ancestor here it resolved against the fixed
          overlay instead — so on mobile, where the card is bottom-aligned, the
          ✕ rendered at the top-right of the VIEWPORT, detached from the box it
          closes. */}
      <div
        ref={dialogRef}
        className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-xl"
      >
        <button
          type="button"
          onClick={dismissForThisVisit}
          aria-label="Close"
          className="absolute right-6 top-6 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground sm:static sm:float-right"
        >
          <X size={16} aria-hidden />
        </button>

        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-amber-400/15 text-amber-500">
          <Star size={26} className="fill-current" aria-hidden />
        </div>

        {!returned ? (
          <>
            <h2 id="google-review-title" className="mt-4 text-lg font-bold tracking-tight">
              Enjoyed your experience?
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your feedback helps {venueName} improve.
            </p>

            {/* A real anchor, so it works without JS and lets the customer
                open it in a new tab if they prefer. rel because it leaves the
                site. Clicking does NOT complete the prompt — it only moves us
                to the confirmation step for when they come back. */}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setReturned(true)}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:-translate-y-0.5 hover:bg-primary-hover hover:shadow-lg active:translate-y-0"
            >
              <Star size={16} aria-hidden /> Rate us on Google
            </a>

            <button
              type="button"
              onClick={dismissForThisVisit}
              className="mt-3 w-full rounded-xl px-6 py-2.5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
            >
              Maybe Later
            </button>
          </>
        ) : (
          <>
            <h2 id="google-review-title" className="mt-4 text-lg font-bold tracking-tight">
              Thanks for your feedback!
            </h2>
            {/* Deliberately a QUESTION, not a statement. We cannot see whether
                they submitted anything, so we ask rather than assert — and
                "Not yet" leaves the prompt pending so they are asked again. */}
            <p className="mt-1.5 text-sm text-muted-foreground">
              Did you get a chance to leave your review?
            </p>

            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  // Failure is deliberately silent: the prompt simply stays
                  // pending and is asked again next visit, which is a better
                  // outcome than an error banner over a courtesy dialog.
                  await confirmGoogleReviewLeft()
                  setOpen(false)
                })
              }
              className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : "Yes, I've left my review"}
            </button>

            <button
              type="button"
              onClick={dismissForThisVisit}
              className="mt-3 w-full rounded-xl px-6 py-2.5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
            >
              Not yet
            </button>
          </>
        )}
      </div>
    </div>
  )
}
