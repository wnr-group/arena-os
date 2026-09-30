import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listActiveWalkins } from '@/lib/booking/walkin'
import { listBookingPaymentStates } from '@/lib/billing/data'
import { SessionsBoard } from '@/components/sessions/SessionsBoard'

/**
 * The live walk-in sessions board (M21 #6) — every active walk-in (open tab
 * or timed) on the branch, independent of any selected day, with a live
 * countdown/elapsed readout and the time's-up alarm. Same gate as starting
 * or checking out a walk-in (lib/actions/bookings.ts): a restaurant tenant
 * uses Tables/Seat-a-party instead and has no walk-ins to show here.
 *
 * Client-side only for v1 — no realtime push. The board polls/re-derives
 * everything from committed_end_at and a periodic previewWalkinCheckout
 * call; the server (checkoutWalkinCore/extendWalkinCore) stays the only
 * source of truth for money and for the committed end itself, so closing
 * every board tab can never mis-bill anything, and reopening one just
 * re-reads the same server state fresh. A push-based upgrade (M10) would
 * replace the polling with a subscription and leave this billing boundary
 * untouched.
 */
export default async function SessionsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (ctx.tenant.industry === 'restaurant' || !canManageWalkins(ctx.role)) {
    redirect('/bookings')
  }

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const activeWalkins = await listActiveWalkins(ctx, branch.id)
  // M25 #2: same "absence means no live invoice" signal BookingsView's own
  // paymentStates already uses — gates the Sessions board's "Reopen tab"
  // action, which reopenWalkinCore refuses once a live bill exists anyway.
  const paymentStates = await listBookingPaymentStates(ctx, activeWalkins.map((w) => w.bookingId))

  return (
    <SessionsBoard
      branchName={branch.name}
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
      sessions={activeWalkins.map((w) => ({
        bookingId: w.bookingId,
        bookingNumber: w.bookingNumber,
        customerName: w.customerName,
        customerPhone: w.customerPhone,
        resourceName: w.resourceName,
        resourceTypeName: w.resourceTypeName,
        startsAt: w.startsAt.toISOString(),
        endsAt: w.endsAt ? w.endsAt.toISOString() : null,
        billingMode: w.billingMode,
        slotTotal: w.slotTotal,
        rateApplied: w.rateApplied,
        pricingMode: w.pricingMode,
        headCount: w.headCount,
        minPlayers: w.minPlayers,
        extraPlayerRateApplied: w.extraPlayerRateApplied,
        includedPlayers: w.includedPlayers,
        warningMinutes: w.warningMinutes,
        hasLiveBill: Boolean(paymentStates[w.bookingId]),
        // M26 #5: '0.00' for every non-gaming_cafe tenant (advance_paid can
        // never be non-zero there — see startWalkinCore's own industry
        // gate), so the live "Partially paid" indicator is already a no-op
        // for them without needing a separate industry flag here.
        advancePaid: w.advancePaid,
      }))}
    />
  )
}
