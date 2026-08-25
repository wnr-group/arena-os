import { Sparkles, Wallet } from 'lucide-react'
import { getPortalWallet } from '@/lib/portal/wallet'
import { portalTenant } from '@/lib/portal/tenant'
import { LedgerList } from '@/components/portal/LedgerList'
import { TierCard } from '@/components/portal/TierCard'
import { formatMoney } from '@/lib/format'

/**
 * Wallet & rewards — read-only.
 *
 * Inside app/(portal), so PortalLayout's requireCustomer() has already
 * validated the session and bounced an unauthenticated visitor to
 * /account/login before this renders. getPortalWallet() takes no arguments; it
 * resolves the customer from that same session.
 *
 * The tier section renders from migration 0049's ladder. TierCard returns null
 * when a venue has no ladder configured at all, so the page still reads well
 * for a tenant that has emptied it.
 */
export default async function PortalWalletPage() {
  const [tenant, data] = await Promise.all([portalTenant(), getPortalWallet()])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Wallet &amp; rewards</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your balance and recent activity at {tenant.name}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <BalanceCard
          icon={<Wallet size={18} />}
          label="Wallet balance"
          value={formatMoney(data.walletBalance, tenant.currency)}
        />
        <BalanceCard
          icon={<Sparkles size={18} />}
          label="Loyalty points"
          value={`${data.loyaltyPoints} ${data.loyaltyPoints === 1 ? 'point' : 'points'}`}
        />
      </div>

      <TierCard standing={data.tier} />

      <LedgerList
        title="Wallet activity"
        entries={data.wallet}
        emptyMessage="Your wallet has no activity yet."
        timeZone={tenant.timezone}
        currency={tenant.currency}
        kind="money"
      />

      <LedgerList
        title="Loyalty activity"
        entries={data.loyalty}
        emptyMessage="No loyalty activity yet."
        timeZone={tenant.timezone}
        currency={tenant.currency}
        kind="points"
      />

      <p className="text-xs text-muted-foreground">
        Balances are worked out from your full history at this venue and always match what the
        venue sees.
      </p>
    </div>
  )
}

function BalanceCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  // Matches StatCard on the portal overview, which in turn matches the staff
  // views' stat cards — one card treatment across the whole product.
  return (
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5">
      <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform duration-300 group-hover:scale-110">
        {icon}
      </span>
      <p className="mt-3 text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
