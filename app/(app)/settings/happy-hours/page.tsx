import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listHappyHours } from '@/lib/happy-hours/data'
import { HappyHoursManager } from '@/components/settings/HappyHoursManager'

export default async function HappyHoursSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const happyHours = await listHappyHours(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Happy Hours</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Time-boxed discount rules applied to eligible menu items — tenant-scoped and manager only.
      </p>
      <HappyHoursManager
        currency={ctx.tenant.currency}
        timezone={ctx.tenant.timezone}
        happyHours={happyHours.map((h) => ({
          id: h.id,
          name: h.name,
          daysOfWeek: h.daysOfWeek,
          startTime: h.startTime,
          endTime: h.endTime,
          discountType: h.discountType,
          discountValue: h.discountValue,
          isActive: h.isActive,
        }))}
      />
    </div>
  )
}
