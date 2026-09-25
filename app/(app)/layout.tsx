import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/session'
import { getActiveContext } from '@/lib/tenant/context'
import { ROLE_LABELS, canManageWalkins } from '@/lib/auth/roles'
import { signOut } from '@/lib/actions/auth'
import { getPublishedBranding } from '@/lib/website/public'
import { AppShell } from '@/components/AppShell'
import { withUser } from '@/db'
import { branches } from '@/db/schema'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  restaurant: 'Restaurant',
  other: 'Business',
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const ctx = await getActiveContext()
  if (!ctx) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">No access to this workspace</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You are signed in as {user.email}, but you are not a member of this
            business. Check the subdomain, or contact the owner for an invite.
          </p>
          <form action={signOut} className="mt-6">
            <button className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">
              Sign out
            </button>
          </form>
        </div>
      </main>
    )
  }

  const { tenant, role } = ctx

  // Same gate as the Sessions nav entry (Sidebar.tsx) — only fetch the branch
  // the top bar's global alarm needs to poll when there's actually something
  // for it to poll.
  const walkinsEnabled = tenant.industry !== 'restaurant' && canManageWalkins(role)
  const branchId = walkinsEnabled
    ? await withUser(ctx.user.id, async (tx) => {
        const [branch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.tenantId, tenant.id), eq(branches.isPrimary, true)))
          .limit(1)
        return branch?.id ?? null
      })
    : null

  // The website builder's PUBLISHED logo (Settings → Website → Branding) —
  // the same getPublishedBranding every public page reads (see its own doc
  // comment in lib/website/public.ts), so the sidebar shows exactly what
  // customers see, never an unpublished draft. Null until the tenant has
  // uploaded one and published at least once, which falls back to the
  // initials badge AppShell already draws.
  const { logoUrl } = await getPublishedBranding(tenant.id)

  return (
    // Merge note: the responsive AppShell (from main) replaced the inline
    // sidebar/header this file used to render. The `no-print` chrome-hiding that
    // the invoice receipt depends on therefore lives inside AppShell now.
    <AppShell
      industryLabel={INDUSTRY_LABELS[tenant.industry] ?? 'Business'}
      industry={tenant.industry}
      tenantName={tenant.name}
      logoUrl={logoUrl}
      role={role}
      userFullName={user.fullName}
      userEmail={user.email}
      roleLabel={ROLE_LABELS[role]}
      signOutAction={signOut}
      walkinsEnabled={walkinsEnabled}
      branchId={branchId}
    >
      {children}
    </AppShell>
  )
}
