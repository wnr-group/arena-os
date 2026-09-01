import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { rootDomain } from '@/lib/tenant/subdomain'
import { listPublicPlans } from '@/lib/platform/plans/public'
import { MarketingNavbar } from '@/components/marketing/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { SignupWizard } from '@/components/signup/SignupWizard'

/**
 * Self-serve signup (M16 #6) — a business creating its own Arena OS workspace
 * without a platform admin.
 *
 * ── Why it lives at app/signup rather than in a route group ─────────────────
 *
 * app/(public) is the TENANT public site: its layout resolves a slug from the
 * subdomain and 404s without one. Signup is the opposite — it exists precisely
 * because no tenant exists yet — so it sits beside app/login at the app root,
 * which is the same place the staff login and the marketing homepage already
 * occupy on the root domain.
 *
 * proxy.ts needs no change for this. `needsSession` there is
 * `(slug || pathname.startsWith('/admin')) && …`, so on the root domain — where
 * there is no slug and this is not /admin — the route is public already.
 *
 * ── Root domain only ────────────────────────────────────────────────────────
 *
 * A tenant subdomain 404s this route. `acme.arenaos.app/signup` is a nonsense
 * address (Acme does not sign new businesses up), and leaving it reachable
 * would mean a tenant-branded page creating unrelated workspaces.
 *
 * The plan catalogue is loaded HERE, on the server, through the RLS-scoped
 * public reader — so the page's first paint already has the real prices and the
 * browser never has to be trusted with them.
 */
export default async function SignupPage() {
  const slug = await currentTenantSlug()
  if (slug) notFound()

  const plans = await listPublicPlans()
  const domain = rootDomain()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <MarketingNavbar />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Start running your venue on Arena OS
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Bookings, POS, kitchen, memberships and reports — set up in a couple of minutes. Start
              a free trial, or subscribe straight away.
            </p>
          </div>

          <SignupWizard plans={plans} domain={domain} />
        </div>
      </main>

      <MarketingFooter domain={domain} />
    </div>
  )
}
