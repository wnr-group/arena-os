'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, Clock, Loader2, Users, XCircle } from 'lucide-react'
import {
  cancelMyEventRegistration,
  createEventRegistrationCheckout,
  joinEventTeam,
  registerForEvent,
} from '@/lib/actions/event-registrations'
import {
  EVENT_REGISTRATION_STATUS_LABELS,
  type EventRegistrationMode,
  type EventRegistrationStatus,
  type EventTeamOption,
} from '@/lib/events/registration'
import { loadCheckoutScript } from '@/lib/payments/checkout-script'
import { formatMoney } from '@/lib/format'

/**
 * The Register CTA's working end (M15 #3).
 *
 * ── What this component is NOT allowed to decide ────────────────────────────
 *
 * Anything. It sends an event id (and, for a team event, a team name or a team
 * id) and renders whichever of `registered` / `waitlisted` / `pending_payment`
 * the server chose. It does not decide whether there is room, whether the
 * customer is eligible, or what the fee is — the price shown here is display
 * only, and the amount actually charged is read from the event row by the
 * server and pinned by a WITH CHECK in migration 0083.
 *
 * ── Razorpay ────────────────────────────────────────────────────────────────
 *
 * Checkout is opened with the order id and key id the server returns, through
 * the SAME loadCheckoutScript() helper the deposit button and the food-order
 * checkout use. Its `handler` callback is treated as a HINT — it refreshes the
 * page and nothing more. A browser saying "paid" proves nothing; the webhook is
 * the only thing that confirms a place, so what the customer sees after paying
 * is whatever the server now says, which may still be "payment pending" for the
 * seconds before the webhook lands.
 */

type Participation = {
  registrationId: string
  status: EventRegistrationStatus
  isCaptain: boolean
  isOwnRegistration: boolean
  teamId: string | null
  teamName: string | null
  teamMemberCount: number
  waitlistPosition: number | null
  paidAmount: string | null
  refundRequired: boolean | null
  /** ISO string — Dates do not cross the server/client boundary. */
  holdExpiresAt: string | null
}

const btn =
  'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-60'
const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'

export function EventRegisterPanel({
  eventId,
  eventTitle,
  entryFee,
  currency,
  venueName,
  registrationMode,
  teamSize,
  spotsLeft,
  customerName,
  customerPhone,
  participation,
  teams,
}: {
  eventId: string
  eventTitle: string
  entryFee: string
  currency: string
  venueName: string
  registrationMode: EventRegistrationMode
  teamSize: number | null
  spotsLeft: number | null
  customerName: string | null
  customerPhone: string
  participation: Participation | null
  teams: EventTeamOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [paying, setPaying] = useState(false)
  const [teamName, setTeamName] = useState('')

  const free = Number(entryFee) === 0
  // A preview only — the server decides again, under a lock, when the button is
  // pressed. Saying "you will be waitlisted" and then confirming a place is a
  // pleasant surprise; the reverse is the one this wording avoids.
  const likelyWaitlist = spotsLeft === 0

  /** Open Razorpay for a held place. Never called for a free or waitlisted entry. */
  async function pay(registrationId: string) {
    setPaying(true)
    try {
      const result = await createEventRegistrationCheckout({ registrationId })
      if (result.error || !result.checkout) {
        toast.error(result.error ?? 'Could not start the payment.')
        return
      }
      const { checkout } = result
      const Razorpay = await loadCheckoutScript()
      const rz = new Razorpay({
        key: checkout.keyId,
        order_id: checkout.orderId,
        amount: checkout.amount,
        currency: checkout.currency,
        name: venueName,
        description: `Entry — ${checkout.eventTitle}`,
        prefill: { name: customerName ?? undefined, contact: customerPhone },
        // A hint, not a confirmation. The webhook is the authority; refreshing
        // shows whatever the server actually believes.
        handler: () => router.refresh(),
        modal: { ondismiss: () => router.refresh() },
      })
      rz.open()
    } catch {
      toast.error('The payment window could not be opened. Please try again.')
    } finally {
      setPaying(false)
    }
  }

  function submitRegistration() {
    startTransition(async () => {
      const result = await registerForEvent({
        eventId,
        teamName: registrationMode === 'team' ? teamName.trim() : undefined,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.status === 'waitlisted') {
        toast.success('You are on the waitlist — we will let you know if a place opens up.')
      } else if (result.needsPayment && result.registrationId) {
        toast.success('A place is being held for you. Complete payment to confirm it.')
        router.refresh()
        await pay(result.registrationId)
        return
      } else {
        toast.success('You are registered.')
      }
      router.refresh()
    })
  }

  function submitJoin(teamId: string) {
    startTransition(async () => {
      const result = await joinEventTeam({ teamId, eventId })
      if (result.error) toast.error(result.error)
      else {
        toast.success('You have joined the team.')
        router.refresh()
      }
    })
  }

  function submitCancel(registrationId: string) {
    startTransition(async () => {
      const result = await cancelMyEventRegistration({ registrationId, eventId })
      if (result.error) toast.error(result.error)
      else {
        toast.success('Your registration has been cancelled.')
        router.refresh()
      }
    })
  }

  // ── already in this event ────────────────────────────────────────────────
  if (participation) {
    const p = participation
    return (
      <div className="space-y-4">
        <StatusBanner participation={p} />

        {p.teamName && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users size={15} aria-hidden />
            <span>
              {p.isCaptain ? 'Captain of' : 'Playing for'} <strong className="text-foreground">{p.teamName}</strong>
              {teamSize ? ` · ${p.teamMemberCount} of ${teamSize} players` : ''}
            </span>
          </p>
        )}

        {p.status === 'pending_payment' && p.isOwnRegistration && (
          <>
            <p className="text-sm text-muted-foreground">
              We are holding your place until you pay
              {p.holdExpiresAt ? ` (until ${new Date(p.holdExpiresAt).toLocaleString()})` : ''}. Your
              place is only confirmed once the payment clears.
            </p>
            <button
              type="button"
              className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
              disabled={paying || pending}
              onClick={() => pay(p.registrationId)}
            >
              {paying ? <Loader2 size={18} className="animate-spin" /> : null}
              Pay {formatMoney(entryFee, currency)}
            </button>
          </>
        )}

        {p.refundRequired && (
          <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
            We received your payment but could not hold your place. The venue will be in touch about
            a refund — nothing further is needed from you.
          </p>
        )}

        {p.isOwnRegistration && p.status !== 'cancelled' && p.status !== 'checked_in' && (
          <button
            type="button"
            className={`${btn} border border-border bg-background text-foreground hover:bg-muted`}
            disabled={pending}
            onClick={() => submitCancel(p.registrationId)}
          >
            {pending ? <Loader2 size={18} className="animate-spin" /> : null}
            Cancel my registration
          </button>
        )}

        {!p.isOwnRegistration && (
          <p className="text-sm text-muted-foreground">
            Your captain holds this entry — ask them to withdraw the team if your plans change.
          </p>
        )}
      </div>
    )
  }

  // ── not in it yet ────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {likelyWaitlist && (
        <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          This event is full. You can still join the waitlist — we will offer you a place if one
          opens up, and you will not be charged unless you accept it.
        </p>
      )}

      {registrationMode === 'team' ? (
        <>
          <div>
            <label className="text-sm font-medium text-muted-foreground" htmlFor="team-name">
              Your team name
            </label>
            <input
              id="team-name"
              className={`${input} mt-1.5`}
              value={teamName}
              maxLength={80}
              placeholder="e.g. Thunderbolts"
              onChange={(e) => setTeamName(e.target.value)}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              You enter as captain{teamSize ? ` and can add up to ${teamSize - 1} team-mates` : ''}.
              {!free && ' The entry fee is charged once per team.'}
            </p>
          </div>

          <button
            type="button"
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            disabled={pending || paying || teamName.trim().length === 0}
            onClick={submitRegistration}
          >
            {pending || paying ? <Loader2 size={18} className="animate-spin" /> : null}
            {likelyWaitlist ? 'Join the waitlist' : free ? 'Enter my team' : `Enter and pay ${formatMoney(entryFee, currency)}`}
          </button>

          {teams.length > 0 && (
            <div className="border-t border-border pt-4">
              <p className="text-sm font-medium">…or join a team that is already entered</p>
              <ul className="mt-2 space-y-2">
                {teams.map((t) => {
                  const full = t.memberCount >= t.teamSize
                  return (
                    <li
                      key={t.teamId}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{t.teamName}</span>
                        <span className="text-xs text-muted-foreground">
                          {t.memberCount} of {t.teamSize} players
                        </span>
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
                        disabled={pending || full}
                        onClick={() => submitJoin(t.teamId)}
                      >
                        {full ? 'Full' : 'Join'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
          disabled={pending || paying}
          onClick={submitRegistration}
        >
          {pending || paying ? <Loader2 size={18} className="animate-spin" /> : null}
          {likelyWaitlist
            ? 'Join the waitlist'
            : free
              ? `Register for ${eventTitle}`
              : `Register and pay ${formatMoney(entryFee, currency)}`}
        </button>
      )}

      <p className="text-xs text-muted-foreground">
        Registering as {customerName ? `${customerName} · ` : ''}
        {customerPhone}.
      </p>
    </div>
  )
}

/** One line saying where the customer stands, in the colour that says it too. */
function StatusBanner({ participation }: { participation: Participation }) {
  const { status, waitlistPosition } = participation
  const label = EVENT_REGISTRATION_STATUS_LABELS[status]

  if (status === 'registered' || status === 'checked_in') {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700">
        <CheckCircle2 size={17} aria-hidden /> {label} — your place is confirmed.
      </p>
    )
  }
  if (status === 'waitlisted') {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700">
        <Clock size={17} aria-hidden />
        {waitlistPosition
          ? `You are number ${waitlistPosition} on the waitlist.`
          : 'You are on the waitlist.'}
      </p>
    )
  }
  if (status === 'pending_payment') {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-700">
        <Clock size={17} aria-hidden /> {label} — your place is held but not yet confirmed.
      </p>
    )
  }
  return (
    <p className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm font-medium text-muted-foreground">
      <XCircle size={17} aria-hidden /> {label}
    </p>
  )
}
