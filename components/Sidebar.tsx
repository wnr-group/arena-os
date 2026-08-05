'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarDays, LayoutDashboard, Settings, Boxes, Clock, Users, Contact } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { canViewCustomers, isManager, type MemberRole } from '@/lib/auth/roles'

// `can` gates an entry on the member's role. Omit it for surfaces every member
// may reach (Dashboard, Bookings). Keep it a predicate rather than a flag so a
// module with its own access rule — like Customers — doesn't need a new prop.
const NAV: {
  href: string
  label: string
  icon: typeof LayoutDashboard
  can?: (role: MemberRole) => boolean
}[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  { href: '/customers', label: 'Customers', icon: Contact, can: canViewCustomers },
  { href: '/settings/resources', label: 'Resources', icon: Boxes, can: isManager },
  { href: '/settings/hours', label: 'Working Hours', icon: Clock, can: isManager },
  { href: '/settings/team', label: 'Team', icon: Users, can: isManager },
]

export function Sidebar({ role }: { role: MemberRole }) {
  const pathname = usePathname()
  const items = NAV.filter((n) => !n.can || n.can(role))

  return (
    <nav className="flex flex-col gap-1 p-3">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/')
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon size={16} />
            {item.label}
          </Link>
        )
      })}
      <div className="mt-2 flex items-center gap-3 rounded-md px-3 py-2 text-xs text-muted-foreground">
        <Settings size={14} /> More modules coming
      </div>
    </nav>
  )
}
