import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { rootDomain } from '@/lib/tenant/subdomain'
import { getPaymentSettingsForClient } from '@/lib/settings/payment-settings'
import { PaymentSettingsForm } from '@/components/settings/PaymentSettingsForm'

export default async function PaymentSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — savePaymentSettings() calls requireManager() itself,
  // and payment_settings_write is manager-only in RLS on top of that.
  if (!isManager(ctx.role)) redirect('/dashboard')

  // Returns { razorpayKeyId, hasSecret } and nothing else. The encrypted secret
  // is not selected out of Postgres, so it cannot reach this render at all.
  const settings = await getPaymentSettingsForClient(ctx)

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Payment settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your own Razorpay account, used for online booking deposits. Only owners and managers
        can change these.
      </p>
      <PaymentSettingsForm
        razorpayKeyId={settings.razorpayKeyId ?? ''}
        hasSecret={settings.hasSecret}
        hasWebhookSecret={settings.hasWebhookSecret}
        // Built from the tenant's own subdomain — the host is what tells the
        // webhook route which tenant's signing secret to verify against.
        webhookUrl={`https://${ctx.tenant.slug}.${rootDomain()}/api/webhooks/razorpay`}
      />
    </div>
  )
}
