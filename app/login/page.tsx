import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/session'
import { currentTenantSlug } from '@/lib/tenant/context'
import { LoginForm } from './LoginForm'

/**
 * The staff sign-in page.
 *
 * ── WHY THIS IS A SERVER COMPONENT ──────────────────────────────────────────
 *
 * Someone already signed in has no business seeing a sign-in form. They used
 * to: pressing Back from the dashboard landed here, showed the form, and Back
 * again returned to the dashboard — which reads like the session is being
 * bypassed even though it never was. (It was not: the session stayed valid the
 * whole time, so returning to the dashboard was correct. What was wrong is
 * that this page rendered at all.)
 *
 * Half the fix is in lib/actions/auth.ts, which now REPLACES this entry in the
 * history stack instead of pushing past it, so Back from the dashboard skips
 * it. This is the other half, and the durable one: the check runs however the
 * page is reached — Back, a bookmark, a typed URL, a restored tab.
 *
 * The test is `getCurrentUser()`, the real session lookup, NOT the cookie
 * presence check proxy.ts uses for routing. A stale or revoked cookie must
 * still get the form rather than be bounced to a dashboard that would only
 * send it back here.
 */
export default async function LoginPage() {
  const user = await getCurrentUser()
  if (user) {
    // Same destination the login action itself picks: a tenant subdomain goes
    // to the workspace, the root/admin domain to the platform panel.
    const slug = await currentTenantSlug()
    redirect(slug ? '/dashboard' : '/admin')
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Arena OS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your workspace</p>
        </div>

        <LoginForm />
      </div>
    </main>
  )
}
