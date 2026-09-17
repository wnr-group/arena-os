'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { CalendarDays, LogOut, Trophy, User, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/**
 * Chrome for the customer portal (AROS-88).
 *
 * Deliberately NOT AppShell. That shell is built around staff work — a role
 * label, a collapsible module sidebar, print-hiding for receipts — and a
 * customer has none of those. Sharing it would mean every future staff nav
 * change had to be re-checked against a completely different audience, and one
 * mistake there would put a staff-only link in front of a customer.
 *
 * The nav is a short, flat list because the portal is a handful of pages. Items
 * whose pages land in AROS-89 to AROS-92 are rendered as disabled placeholders
 * rather than hidden, so the shape of the portal is visible now and each later
 * ticket only has to flip one flag.
 */

type NavItem = { href: string; label: string; icon: typeof User; ready: boolean }

const NAV: NavItem[] = [
  { href: '/account', label: 'Overview', icon: User, ready: true },
  { href: '/account/bookings', label: 'Bookings', icon: CalendarDays, ready: true },
  { href: '/account/events', label: 'Events', icon: Trophy, ready: true },
  { href: '/account/wallet', label: 'Wallet & rewards', icon: Wallet, ready: true },
  { href: '/account/profile', label: 'Profile', icon: User, ready: true },
]

export function PortalShell({
  venueName,
  customerName,
  customerPhone,
  signOutAction,
  children,
}: {
  venueName: string
  customerName: string | null
  customerPhone: string
  signOutAction: () => void | Promise<void>
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <Link
              href="/account"
              className="truncate text-base font-semibold transition-colors hover:text-primary"
            >
              {venueName}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {customerName ? `${customerName} · ` : ''}
              {customerPhone}
            </p>
          </div>

          {/* A form, not an onClick: sign-out revokes a session row and clears
              an httpOnly cookie, both of which are server work. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition hover:bg-muted"
            >
              <LogOut size={15} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </form>
        </div>

        <nav className="mx-auto max-w-4xl overflow-x-auto px-4 sm:px-6">
          <ul className="flex gap-1 pb-2">
            {NAV.map(({ href, label, icon: Icon, ready }) => {
              // Overview is an exact match (it is the prefix of every other
              // route); the rest stay highlighted on their detail pages too,
              // so /account/bookings/<id> still shows "Bookings" as current.
              const active =
                href === '/account' ? pathname === href : pathname.startsWith(href)
              // A filled brand pill for the current tab, matching the staff
              // sidebar's active state. The portal previously marked it with a
              // 2px underline, which was the only brand-coloured pixel on the
              // whole surface.
              const className = cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/10'
                  : 'text-muted-foreground',
                ready && !active ? 'hover:bg-muted hover:text-foreground' : '',
                ready ? '' : 'cursor-not-allowed opacity-50',
              )

              return (
                <li key={href}>
                  {ready ? (
                    <Link href={href} className={className}>
                      <Icon size={15} />
                      {label}
                    </Link>
                  ) : (
                    <span className={className} aria-disabled="true" title="Coming soon">
                      <Icon size={15} />
                      {label}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
