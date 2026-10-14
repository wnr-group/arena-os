import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArenaLogo } from '@/components/ui/ArenaLogo'
import { ArenaWordmark } from '@/components/marketing/ui/ArenaWordmark'
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
          <Link href="/admin" className="group flex min-w-0 items-center gap-2.5">
            <ArenaLogo className="h-9 w-auto shrink-0" />
            <ArenaWordmark />
            <span className="text-sm font-semibold text-muted-foreground">· Platform Admin</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-muted-foreground transition-colors hover:text-foreground">
              Companies
            </Link>
            <Link href="/admin/plans" className="text-muted-foreground transition-colors hover:text-foreground">
              Plans
            </Link>
            {/* Two distinct surfaces, deliberately named apart: "Revenue" is
                the money (AROS-114), "Billing" is the platform's own Razorpay
                account and GST letterhead (M16 #3/#4). */}
            <Link href="/admin/revenue" className="text-muted-foreground transition-colors hover:text-foreground">
              Revenue
            </Link>
            <Link href="/admin/billing" className="text-muted-foreground transition-colors hover:text-foreground">
              Billing
            </Link>
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
