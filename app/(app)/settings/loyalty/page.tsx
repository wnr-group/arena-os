import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getLoyaltySettings } from '@/lib/loyalty/data'
import { LoyaltySettingsForm } from '@/components/settings/LoyaltySettingsForm'

/**
 * Loyalty programme settings — manager/owner only.
 *
 * Same shape as the other settings pages (see settings/tax-rates): resolve the
 * context, gate on isManager, load server-side, hand plain data to the client
 * form. The redirect here is convenience; the action re-checks with
 * requireManager() and the loyalty_settings_write RLS policy checks again in
 * the database.
 *
 * A tenant that has never configured the programme sees DEFAULT_LOYALTY_RULE —
 * the same values the till is already using — rather than an empty form, so
 * "what is currently in effect" and "what this page shows" never differ.
 */
export default async function LoyaltySettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const settings = await getLoyaltySettings(ctx)

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Loyalty Programme</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        How customers earn and spend points — tenant-scoped and manager only. Changes apply to the
        next bill immediately; points already earned or redeemed keep the rate they were given.
      </p>

      <LoyaltySettingsForm
        initial={{
          pointsPerUnit: settings.pointsPerUnit,
          unitAmount: settings.unitAmount,
          pointValue: settings.pointValue,
          minRedeemPoints: settings.minRedeemPoints,
          isActive: settings.isActive,
        }}
        currency={ctx.tenant.currency}
      />
    </div>
  )
}
