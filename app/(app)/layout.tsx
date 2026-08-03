import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/session'
import { getActiveContext } from '@/lib/tenant/context'
import { ROLE_LABELS, isManager } from '@/lib/auth/roles'
import { signOut } from '@/lib/actions/auth'
import { Sidebar } from '@/components/Sidebar'

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
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r sm:flex">
        <div className="border-b px-5 py-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {INDUSTRY_LABELS[tenant.industry] ?? 'Business'}
          </p>
          <p className="truncate font-semibold">{tenant.name}</p>
        </div>
        <Sidebar isManager={isManager(role)} />
        <div className="mt-auto border-t p-3">
          <p className="truncate px-2 text-sm font-medium">{user.email}</p>
          <p className="px-2 text-xs text-muted-foreground">{ROLE_LABELS[role]}</p>
          <form action={signOut} className="mt-2">
            <button className="w-full rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3 sm:hidden">
          <span className="font-semibold">{tenant.name}</span>
          <form action={signOut}>
            <button className="text-sm text-muted-foreground">Sign out</button>
          </form>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
