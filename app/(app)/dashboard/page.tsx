import Link from 'next/link'
import { CalendarDays, Boxes } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { ROLE_LABELS, isManager } from '@/lib/auth/roles'
import { getOnboardingProgress } from '@/lib/onboarding/checklist'
import { OnboardingChecklist } from '@/components/onboarding/OnboardingChecklist'

export default async function DashboardPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null // layout already guards this
  const { tenant, role } = ctx

  // New-workspace setup (M16 #6). Derived from what the tenant has actually
  // configured, and renders nothing once every step is done — see
  // lib/onboarding/checklist.ts. Never blocks: the dashboard is fully usable
  // with the panel showing.
  const onboarding = await getOnboardingProgress(ctx)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Welcome Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-card to-muted/20 p-6 sm:p-8 shadow-sm">
        <div className="absolute -right-10 -top-10 size-40 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -left-10 -bottom-10 size-40 rounded-full bg-primary/5 blur-3xl" />
        
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            Active Workspace
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Welcome back to {tenant.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-2xl leading-relaxed">
            You&apos;re signed in as <span className="font-semibold text-foreground">{ROLE_LABELS[role]}</span>. Everything here is scoped to
            your workspace by secure row-level database rules.
          </p>
        </div>
      </div>

      <OnboardingChecklist progress={onboarding} />

      {/* Main Grid */}
      <div className="mt-8">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Quick Actions</h3>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Link
            href="/bookings"
            className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5"
          >
            <div>
              <div className="inline-flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground">
                <CalendarDays size={22} className="transition-transform duration-300 group-hover:scale-110" />
              </div>
              <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">Bookings</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                View today&apos;s schedule, manage reservations, and take walk-in bookings.
              </p>
            </div>
            <div className="mt-6 flex items-center text-xs font-semibold text-primary">
              Open bookings &rarr;
            </div>
          </Link>

          {isManager(role) && (
            <Link
              href="/settings/resources"
              className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5"
            >
              <div>
                <div className="inline-flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground">
                  <Boxes size={22} className="transition-transform duration-300 group-hover:scale-110" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">Resources</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Set up resources like pods, tables, studios, rooms, or other items customer can book.
                </p>
              </div>
              <div className="mt-6 flex items-center text-xs font-semibold text-primary">
                Manage resources &rarr;
              </div>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
