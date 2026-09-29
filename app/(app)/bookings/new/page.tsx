import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageWalkins } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources, listResourceSetups } from '@/lib/booking/data'
import { todayInZone } from '@/lib/booking/time'
import { industryHasStudioSetups } from '@/lib/booking/studio-setups'
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
  searchParams: Promise<{ date?: string; resourceTypeId?: string; resourceId?: string; tab?: string }>
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

  // M26 #4: "amount collected now" is gaming_cafe only — gated here the same
  // way setupsEnabled below gates the studio setup picker (createBookingCore/
  // startWalkinCore both re-check this server-side regardless).
  const advancePaymentEnabled = ctx.tenant.industry === 'gaming_cafe'

  // M24 #4: Setups only exists for a handful of studio-type industries (see
  // lib/booking/studio-setups.ts) — gaming_cafe keeps its existing
  // independent-unit model (PS5-1, PS5-2, Snooker-1, …) untouched, so skip
  // the query entirely rather than fetch data no resource of theirs could
  // ever have (upsertResourceSetup gates creation the same way).
  const setupsEnabled = industryHasStudioSetups(ctx.tenant.industry)
  const [allResources, allSetups] = await Promise.all([
    listResources(ctx, branch.id),
    setupsEnabled ? listResourceSetups(ctx, branch.id) : Promise.resolve([]),
  ])

  // M24 #4: active setups grouped by resource, for the wizard's per-unit
  // setup picker — mirrors the exact grouping app/(app)/settings/resources/
  // units/page.tsx already does for the settings editor, except filtered to
  // isActive here (a staff booking flow has no reason to offer a retired
  // setup, unlike that owner-facing editor which manages both).
  const setupsByResource: Record<string, { id: string; name: string; rate: string; rateUnit: 'hour' | 'day' }[]> = {}
  for (const s of allSetups) {
    if (!s.isActive) continue
    ;(setupsByResource[s.resourceId] ??= []).push({
      id: s.id,
      name: s.name,
      rate: s.rate,
      rateUnit: s.rateUnit === 'day' ? 'day' : 'hour',
    })
  }

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
      pricingMode: r.pricingMode,
      minPlayers: r.minPlayers,
      setups: setupsByResource[r.id] ?? [],
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
      initialResourceId={sp.resourceId}
      resources={resources}
      walkinEnabled={walkinEnabled}
      advancePaymentEnabled={advancePaymentEnabled}
    />
  )
}
