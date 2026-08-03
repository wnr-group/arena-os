import Link from 'next/link'
import { CalendarDays, Boxes } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { ROLE_LABELS, isManager } from '@/lib/auth/roles'

export default async function DashboardPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null // layout already guards this
  const { tenant, role } = ctx

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Welcome to {tenant.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        You&apos;re signed in as {ROLE_LABELS[role]}. Everything here is scoped to
        your workspace by row-level security.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/bookings"
          className="group rounded-lg border p-5 transition hover:border-foreground/30"
        >
          <CalendarDays className="text-primary" />
          <h2 className="mt-3 font-medium">Bookings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            View today&apos;s schedule and take walk-in bookings.
          </p>
        </Link>
        {isManager(role) && (
          <Link
            href="/settings/resources"
            className="group rounded-lg border p-5 transition hover:border-foreground/30"
          >
            <Boxes className="text-primary" />
            <h2 className="mt-3 font-medium">Resources</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Set up the stations, rooms or pods customers can book.
            </p>
          </Link>
        )}
      </div>
    </div>
  )
}
