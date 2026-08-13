import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { getKotForPrint } from '@/lib/kots/data'
import { KotPrintButton } from '@/components/kitchen/KotPrintButton'
import { STATUS_LABEL } from '@/lib/kots/labels'
import { timeInZone, prettyDate } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function KotPrintPage({
  params,
}: {
  params: Promise<{ kotId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { kotId } = await params
  if (!UUID.test(kotId)) notFound()

  // Tenant-scoped: another workspace's kotId returns null under RLS, which is
  // indistinguishable from "no such ticket" — the URL leaks nothing.
  const ticket = await getKotForPrint(ctx, kotId)
  if (!ticket) notFound()

  const tz = ctx.tenant.timezone
  const createdAtIso = ticket.createdAt.toISOString()
  const createdAtDate = todayInZone(tz, ticket.createdAt)

  return (
    <div className="px-4 py-6 sm:px-6">
      {/* ── screen-only action bar ── */}
      <div className="no-print mx-auto flex max-w-md items-center justify-between gap-3">
        <Link
          href="/kitchen"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back
        </Link>
        <KotPrintButton />
      </div>

      {/* ── the ticket ── */}
      <article className="kot-print-sheet print-sheet mx-auto mt-4 max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <header className="border-b border-dashed pb-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Kitchen Ticket
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-wide">{ticket.kotNumber}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {prettyDate(createdAtDate, tz)} · {timeInZone(createdAtIso, tz)}
          </p>
        </header>

        <dl className="space-y-1.5 border-b border-dashed py-4 text-base">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="font-semibold">{ticket.orderNumber}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Booking / Table</dt>
            <dd className="font-semibold">{ticket.bookingNumber ?? 'Walk-in'}</dd>
          </div>
          {ticket.customerName && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Guest</dt>
              <dd className="font-semibold">{ticket.customerName}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-semibold capitalize">{STATUS_LABEL[ticket.status]}</dd>
          </div>
        </dl>

        <section className="py-4">
          {ticket.items.length === 0 ? (
            <p className="text-center text-base text-muted-foreground">No items on this ticket.</p>
          ) : (
            <ul className="space-y-3">
              {ticket.items.map((item) => (
                <li key={item.itemId} className="print-keep">
                  <div className="flex items-baseline justify-between gap-3 text-xl font-bold">
                    <span>{item.itemName}</span>
                    <span className="shrink-0">×{item.qty}</span>
                  </div>
                  {item.specialInstructions && (
                    <p className="mt-0.5 text-base font-medium text-muted-foreground">
                      — {item.specialInstructions}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="border-t border-dashed pt-3 text-center text-xs text-muted-foreground">
          For kitchen use — no prices.
        </footer>
      </article>
    </div>
  )
}
