import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listTaxRates } from '@/lib/tax-rates/data'
import { TaxRatesManager } from '@/components/settings/TaxRatesManager'

export default async function TaxRatesSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const taxRates = await listTaxRates(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Tax Rates</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage GST/tax rates used for pricing menu items and resources — tenant-scoped and manager only.
      </p>
      <TaxRatesManager
        taxRates={taxRates.map((t) => ({
          id: t.id,
          name: t.name,
          percent: t.percent,
          isActive: t.isActive,
        }))}
      />
    </div>
  )
}
