import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getActiveContext } from '@/lib/tenant/context'
import { canBillBooking, isManager } from '@/lib/auth/roles'
import { getBillableForBooking } from '@/lib/billing/data'
import { BillScreen } from '@/components/pos/BillScreen'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Server page for /pos/[bookingId] — loads the billable booking and renders BillScreen with every display-only flag it needs. */
export default async function PosBillPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const { bookingId } = await params
  if (!UUID.test(bookingId)) notFound()

  // Tenant-scoped: another workspace's bookingId returns null under RLS, which
  // is indistinguishable from "no such booking" — so the URL leaks nothing.
  //
  // Loaded BEFORE the permission gate below (unlike the plain canBill check
  // this used to be) because canBillBooking needs the booking's own channel
  // to decide: a walk-in's checkout no longer raises its own invoice — it
  // closes the session and hands off here, same as a reserved booking — so
  // floor staff/receptionist (canManageWalkins, not canBill) must still be
  // able to land on and use THIS screen for a walk-in, while every reserved
  // booking still requires plain canBill. See canBillBooking's own doc
  // comment (lib/auth/roles.ts) for the full reasoning.
  const data = await getBillableForBooking(ctx, bookingId)
  if (!data) notFound()

  if (!canBillBooking(ctx.role, data.booking.channel)) {
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

  // Only plain serialisable data crosses to the client: Date → ISO string.
  const settlement = data.settlement
    ? { ...data.settlement, payments: data.settlement.payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })) }
    : null
  const splitChecks = data.splitChecks
    ? data.splitChecks.map((c) => ({
        invoiceId: c.invoiceId,
        invoiceNumber: c.invoiceNumber,
        seq: c.seq,
        label: `Check ${c.seq} of ${data.splitChecks!.length}`,
        settlement: {
          ...c.settlement,
          payments: c.settlement.payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
        },
        wallet: c.wallet,
      }))
    : null

  return (
    <BillScreen
      booking={data.booking}
      lines={data.lines}
      existingInvoice={data.existingInvoice}
      settlement={settlement}
      // The issued bill's own stored figures. Once this is present the screen
      // shows it instead of re-pricing `lines`, so the line totals, the GST and
      // the grand total are the ones actually charged.
      issuedPricing={data.issuedPricing}
      // Advisory: lines the bill will charge at a rate the menu no longer
      // uses, because the order snapshotted it before the rate changed.
      taxDrift={data.taxDrift}
      splitChecks={splitChecks}
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
      serviceChargeConfig={data.serviceChargeConfig}
      staff={data.staff}
      // M18 (split bill / service charge / tips) is restaurant-only — see
      // lib/settings/business-profile.ts's loadServiceChargeConfig for the
      // actual enforcement; this just keeps the Split-bill button and tip
      // input off the screen for every other tenant type.
      isRestaurant={ctx.tenant.industry === 'restaurant'}
      // Bill-level comp (M18 #5) is manager/owner only — see
      // lib/actions/billing.ts's resolveCompInput for the actual
      // enforcement; this just keeps the comp control off a cashier's
      // screen. Combined with isRestaurant above to gate the control itself.
      isManager={isManager(ctx.role)}
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
    />
  )
}
