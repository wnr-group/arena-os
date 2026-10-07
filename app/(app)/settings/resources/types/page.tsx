import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listResourceTypes, listHolidayRates, listResourceTypeAddons } from '@/lib/booking/data'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { asc, desc, eq } from 'drizzle-orm'
import { listTaxRates } from '@/lib/tax-rates/data'
import { findScopeDefaultTaxRate } from '@/lib/tax-rates/resolve'
import { getBusinessProfile } from '@/lib/settings/business'
import { DEFAULT_WEEKEND_DAYS } from '@/lib/settings/business-profile'
import { ResourceTypesManager } from '@/components/settings/ResourceTypesManager'
import { WeekendDaysForm } from '@/components/settings/WeekendDaysForm'
import type { HolidayRateRow } from '@/components/settings/HolidayRatesModal'
import type { ResourceAddonRow } from '@/components/settings/ResourceAddonsModal'

export default async function ResourceTypesPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  // M33: add-on stock is pooled per branch, so the editor lets the owner pick
  // which branch they're configuring (defaulting to the primary one).
  const branchRows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name, isPrimary: branches.isPrimary })
      .from(branches)
      .where(eq(branches.tenantId, ctx.tenant.id))
      .orderBy(desc(branches.isPrimary), asc(branches.name)),
  )

  const [types, taxRates, businessProfile, holidayRates, addons] = await Promise.all([
    listResourceTypes(ctx),
    listTaxRates(ctx),
    getBusinessProfile(ctx),
    listHolidayRates(ctx),
    listResourceTypeAddons(ctx),
  ])

  const addonsByType: Record<string, ResourceAddonRow[]> = {}
  for (const a of addons) {
    ;(addonsByType[a.resourceTypeId] ??= []).push({
      id: a.id,
      resourceTypeId: a.resourceTypeId,
      branchId: a.branchId,
      name: a.name,
      rate: a.rate,
      // Narrowed from the column's plain text — the DB check constraint
      // (0108) guarantees 'hour' | 'day'.
      rateUnit: a.rateUnit === 'day' ? 'day' : 'hour',
      stockQuantity: a.stockQuantity,
      isActive: a.isActive,
      sortOrder: a.sortOrder,
    })
  }

  // M27 #3: group by resourceTypeId for ResourceTypesManager's per-type
  // Holiday rates editor — same "group server-side, one editor per type"
  // shape listResourceSetups' own caller (units/page.tsx) already uses.
  const ratesByType: Record<string, HolidayRateRow[]> = {}
  for (const r of holidayRates) {
    ;(ratesByType[r.resourceTypeId] ??= []).push({ id: r.id, resourceTypeId: r.resourceTypeId, date: r.date, rate: r.rate })
  }
  // The rate a type with no tax_rate_id of its own actually gets charged at
  // (lib/tax-rates/resolve.ts) — shown so "—" never means "not taxed" when
  // it's really "taxed via the tenant's one resources rate."
  const autoResourcesTaxRate = findScopeDefaultTaxRate(taxRates, 'resources')
  // M22 #3: weekend pricing is meaningless for a restaurant tenant — its
  // table types aren't priced by the hour at all (ResourceTypesManager
  // already hides every rate field for one), so the tenant-wide days
  // selector is hidden right alongside them.
  const isRestaurant = ctx.tenant.industry === 'restaurant'

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Resource Types</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Set up the kinds of things customers can book — like “PS5 Station” or “Snooker Table” — with a price per
        hour and a photo.
      </p>
      {!isRestaurant && (
        <div className="mt-5">
          <WeekendDaysForm initialDays={businessProfile?.weekendDays ?? DEFAULT_WEEKEND_DAYS} />
        </div>
      )}
      <ResourceTypesManager
        currency={ctx.tenant.currency}
        industry={ctx.tenant.industry}
        taxRates={taxRates.map((t) => ({ id: t.id, name: t.name, percent: t.percent, appliesTo: t.appliesTo }))}
        autoTaxRate={
          autoResourcesTaxRate
            ? { id: autoResourcesTaxRate.id, name: autoResourcesTaxRate.name, percent: autoResourcesTaxRate.percent }
            : null
        }
        types={types.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          hourlyRate: t.hourlyRate,
          weekendRate: t.weekendRate,
          bufferMinutes: t.bufferMinutes,
          capacity: t.capacity,
          color: t.color,
          imageUrl: t.imageUrl,
          taxRateId: t.taxRateId,
          taxRateName: t.taxRateName,
          pricingMode: t.pricingMode,
          minPlayers: t.minPlayers,
          includedPlayers: t.includedPlayers,
          extraPlayerRate: t.extraPlayerRate,
          extraPlayerWeekendRate: t.extraPlayerWeekendRate,
          isActive: t.isActive,
        }))}
        ratesByType={ratesByType}
        branches={branchRows.map((b) => ({ id: b.id, name: b.name }))}
        addonsByType={addonsByType}
      />
    </div>
  )
}
