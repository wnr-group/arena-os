import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listPromoCodes } from '@/lib/promo-codes/data'
import { PromoCodesManager } from '@/components/settings/PromoCodesManager'

export default async function PromoCodesSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — every mutation calls requireManager(), and promo_write
  // is manager-only in RLS on top of that.
  if (!isManager(ctx.role)) redirect('/dashboard')

  const promos = await listPromoCodes(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Promo Codes</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Discount codes a cashier can apply at billing — tenant-scoped and manager only.
      </p>
      <PromoCodesManager
        currency={ctx.tenant.currency}
        promos={promos.map((p) => ({
          id: p.id,
          code: p.code,
          discountType: p.discountType,
          discountValue: p.discountValue,
          validFrom: p.validFrom.toISOString(),
          validUntil: p.validUntil.toISOString(),
          maxUses: p.maxUses,
          uses: p.uses,
          isActive: p.isActive,
        }))}
      />
    </div>
  )
}
