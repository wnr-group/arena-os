import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/session'
import { getActiveContext } from '@/lib/tenant/context'
import { ROLE_LABELS, isManager } from '@/lib/auth/roles'
import { signOut } from '@/lib/actions/auth'
import { AppShell } from '@/components/AppShell'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
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

  return (
    <AppShell
      industryLabel={INDUSTRY_LABELS[tenant.industry] ?? 'Business'}
      tenantName={tenant.name}
      isManager={isManager(role)}
      userEmail={user.email}
      roleLabel={ROLE_LABELS[role]}
      signOutAction={signOut}
    >
      {children}
    </AppShell>
  )
}
