'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { cancelEventRegistration, checkInEventRegistration } from '@/lib/actions/events'
import {
  EVENT_REGISTRATION_STATUS_LABELS,
  type EventRegistrationStatus,
} from '@/lib/events/registration'
import { formatMoney } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/**
 * The door list, with the two things staff do at it: check someone in, and
 * cancel an entry.
 *
 * Both actions send a registration id and nothing else. Cancelling goes through
 * the same locked function the customer path uses, so freeing the place and
 * promoting the next waiter happen in one transaction — this component never
 * has to know a waitlist exists.
 */

type Entrant = {
  registrationId: string
  status: EventRegistrationStatus
  customerName: string | null
  customerPhone: string
  teamName: string | null
  paidAmount: string
  refundRequired: boolean
  waitlistPosition: number | null
  /** ISO string — Dates do not cross the server/client boundary. */
  createdAt: string
}

const STATUS_CLASS: Record<EventRegistrationStatus, string> = {
  registered: 'bg-emerald-500/10 text-emerald-700',
  checked_in: 'bg-violet-500/10 text-violet-700',
  pending_payment: 'bg-sky-500/10 text-sky-700',
  waitlisted: 'bg-amber-500/10 text-amber-700',
  cancelled: 'bg-muted text-muted-foreground',
}

export function EventEntrantsTable({
  currency,
  entrants,
}: {
  currency: string
  entrants: Entrant[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ error?: string }>, success: string) {
    startTransition(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        toast.success(success)
        router.refresh()
      }
    })
  }

  if (entrants.length === 0) {
    return <p className="mt-8 text-center text-sm text-muted-foreground">Nobody has entered yet.</p>
  }

  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[44rem] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">Entrant</th>
            <th className="px-4 py-2.5 font-medium">Team</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Paid</th>
            <th className="px-4 py-2.5 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entrants.map((e) => (
            <tr key={e.registrationId} className="align-middle">
              <td className="px-4 py-3">
                <span className="block font-medium">{e.customerName ?? 'Guest'}</span>
                <span className="text-xs text-muted-foreground">{e.customerPhone}</span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{e.teamName ?? '—'}</td>
              <td className="px-4 py-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[e.status]}`}
                >
                  {EVENT_REGISTRATION_STATUS_LABELS[e.status]}
                  {e.waitlistPosition ? ` #${e.waitlistPosition}` : ''}
                </span>
                {e.refundRequired && (
                  <span className="ml-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                    Refund due
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {Number(e.paidAmount) > 0 ? formatMoney(e.paidAmount, currency) : '—'}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1.5">
                  {e.status === 'registered' && (
                    <button
                      type="button"
                      disabled={pending}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                      onClick={() =>
                        run(() => checkInEventRegistration(e.registrationId), 'Checked in.')
                      }
                    >
                      {pending ? <Loader2 size={13} className="animate-spin" /> : 'Check in'}
                    </button>
                  )}
                  {e.status !== 'cancelled' && (
                    <button
                      type="button"
                      disabled={pending}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                      onClick={() =>
                        confirm({
                          title: `Cancel ${e.customerName ?? e.customerPhone}'s entry?`,
                          description:
                            Number(e.paidAmount) > 0
                              ? 'Their place is freed and the next waiting entrant is promoted. The payment is kept on record and flagged for a refund — nothing is refunded automatically.'
                              : 'Their place is freed and the next waiting entrant is promoted.',
                          confirmText: 'Cancel entry',
                          onConfirm: async () => {
                            const r = await cancelEventRegistration(e.registrationId)
                            if (r.error) toast.error(r.error)
                            else {
                              toast.success('Entry cancelled.')
                              router.refresh()
                            }
                          },
                        })
                      }
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
