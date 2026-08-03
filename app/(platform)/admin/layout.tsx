import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth/session'
import { signOut } from '@/lib/actions/auth'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  if (!user.isPlatformAdmin) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Platform administrators only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You are signed in as {user.email}, which is not a platform admin account.
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

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/admin" className="flex items-center gap-2 font-semibold">
            <ShieldCheck size={18} className="text-primary" />
            Arena OS <span className="text-muted-foreground">· Platform Admin</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">{user.email}</span>
            <form action={signOut}>
              <button className="rounded-md border px-3 py-1.5 hover:bg-muted">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  )
}
