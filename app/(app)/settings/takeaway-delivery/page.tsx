import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { getTypedOrderSettingsCore } from '@/lib/orders/typed'
import { TypedOrderSettingsForm } from '@/components/settings/TypedOrderSettingsForm'

export default async function TakeawayDeliverySettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.takeaway_delivery'))) redirect('/dashboard')

  const settings = await withUser(ctx.user.id, (tx) => getTypedOrderSettingsCore(tx, ctx.tenant.id))
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Takeaway &amp; delivery</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Orders that aren&apos;t for a table. Everything stays off until you switch it on; dine-in is never affected.
      </p>
      <TypedOrderSettingsForm initial={settings} />
    </div>
  )
}
