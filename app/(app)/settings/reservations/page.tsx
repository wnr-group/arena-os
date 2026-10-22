import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { getReservationSettings } from '@/lib/reservations/data'
import { ReservationSettingsForm } from '@/components/settings/ReservationSettingsForm'

export default async function ReservationSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.table_reservations'))) redirect('/dashboard')

  const settings = await getReservationSettings(ctx)
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Table reservations</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Let guests reserve a table for a time and party size. Everything stays off until you switch it on.
      </p>
      <ReservationSettingsForm initial={settings} />
    </div>
  )
}
