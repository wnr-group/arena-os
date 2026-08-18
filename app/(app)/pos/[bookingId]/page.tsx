import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getActiveContext } from '@/lib/tenant/context'
import { canBill } from '@/lib/auth/roles'
import { getBillableForBooking } from '@/lib/billing/data'
import { BillScreen } from '@/components/pos/BillScreen'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PosBillPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { bookingId } = await params
  if (!UUID.test(bookingId)) notFound()

  if (!canBill(ctx.role)) {
    return (
      <div className="px-6 py-10">
        <div className="mx-auto max-w-md rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            You do not have permission to raise a bill. Ask an owner or manager.
          </p>
          <Link href="/bookings" className="mt-3 inline-block text-sm font-medium underline">
            Back to bookings
          </Link>
        </div>
      </div>
    )
  }

  // Tenant-scoped: another workspace's bookingId returns null under RLS, which
  // is indistinguishable from "no such booking" — so the URL leaks nothing.
  const data = await getBillableForBooking(ctx, bookingId)
  if (!data) notFound()

  // Only plain serialisable data crosses to the client: Date → ISO string.
  const settlement = data.settlement
    ? { ...data.settlement, payments: data.settlement.payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })) }
    : null

  return (
    <BillScreen
      booking={data.booking}
      lines={data.lines}
      existingInvoice={data.existingInvoice}
      settlement={settlement}
      // Display only: every wallet limit is re-checked under a lock by the
      // action, which reads the balance from the ledger itself.
      wallet={data.wallet}
      // Display only: the server prices the redemption, caps it and debits.
      loyalty={
        data.loyalty
          ? {
              balance: data.loyalty.balance,
              pointValue: data.loyalty.rule.pointValue,
              minRedeemPoints: data.loyalty.rule.minRedeemPoints,
            }
          : null
      }
      // Display only: the action re-resolves the benefit server-side.
      membership={
        data.membership
          ? {
              planName: data.membership.planName,
              discountPercent: data.membership.discountPercent,
              discountAmount: data.membership.discountAmount,
            }
          : null
      }
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
    />
  )
}
