'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { cancelMyEventRegistration } from '@/lib/actions/event-registrations'
import type { EventRegistrationStatus } from '@/lib/events/registration'

/**
 * The actions on one row of "My events" — the only interactive part of an
 * otherwise server-rendered list, kept in its own client component for the same
 * reason CancelBookingButton is.
 *
 * `pending_payment` sends the customer back to the event's registration page
 * rather than opening Checkout here: that page already owns the whole payment
 * flow (order creation, the Razorpay script, the post-payment refresh) and a
 * second copy of it would be a second thing to keep correct.
 *
 * Cancelling passes a registration id and nothing else. Ownership is checked
 * inside cancel_event_registration() against the session's own customer id, so
 * this component cannot be talked into cancelling anybody else's entry.
 */
export function MyEventRegistrationRow({
  registrationId,
  eventId,
  status,
}: {
  registrationId: string
  eventId: string
  status: EventRegistrationStatus
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const cancellable =
    status === 'registered' || status === 'waitlisted' || status === 'pending_payment'

  if (!cancellable) return null

  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
      {status === 'pending_payment' && (
        <Link
          href={`/events/${eventId}/register`}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          Complete payment
        </Link>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await cancelMyEventRegistration({ registrationId, eventId })
            if (result.error) toast.error(result.error)
            else {
              toast.success('Your registration has been cancelled.')
              router.refresh()
            }
          })
        }
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        Cancel
      </button>
    </div>
  )
}
