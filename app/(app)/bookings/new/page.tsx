import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources } from '@/lib/booking/data'
import { todayInZone } from '@/lib/booking/time'
import { BookingWizard } from '@/components/bookings/new/BookingWizard'

/**
 * The full-page "New booking" flow (M21 #3) — replaces what used to be an
 * in-place modal opened from /bookings. Two tabs (Walk-in / Future), each a
 * multi-step wizard; the underlying actions (startWalkin, createBooking,
 * lookupCustomerByPhone, getAvailableStartsForType) are unchanged from the
 * modal version — this page only changes how they're presented.
 */
export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; resourceTypeId?: string; tab?: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  const sp = await searchParams

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  // Same industry/role gate startWalkin itself re-checks server-side — see
  // lib/actions/bookings.ts. This only decides whether the Walk-in tab is
  // offered at all; a restaurant tenant uses M17 Seat-a-party instead.
  const isRestaurant = ctx.tenant.industry === 'restaurant'
  const walkinEnabled = !isRestaurant && canManageWalkins(ctx.role)

  const allResources = await listResources(ctx, branch.id)
  const resources = allResources
    .filter((r) => r.status !== 'inactive')
    .map((r) => ({
      id: r.id,
      name: r.name,
      resourceTypeId: r.resourceTypeId,
      typeName: r.typeName,
      imageUrl: r.imageUrl ?? r.typeImageUrl,
      hourlyRate: r.typeRate,
      capacity: r.typeCapacity,
    }))

  const today = todayInZone(ctx.tenant.timezone)
  const initialDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today
  const initialTab: 'walkin' | 'future' = sp.tab === 'future' || !walkinEnabled ? 'future' : 'walkin'

  return (
    <BookingWizard
      branchId={branch.id}
      timeZone={ctx.tenant.timezone}
      currency={ctx.tenant.currency}
      today={today}
      initialDate={initialDate}
      initialTab={initialTab}
      initialResourceTypeId={sp.resourceTypeId}
      resources={resources}
      walkinEnabled={walkinEnabled}
    />
  )
}
