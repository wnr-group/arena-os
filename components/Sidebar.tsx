'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarDays, LayoutDashboard, Settings, Boxes, Clock, Users } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  { href: '/settings/resources', label: 'Resources', icon: Boxes, managerOnly: true },
  { href: '/settings/hours', label: 'Working Hours', icon: Clock, managerOnly: true },
  { href: '/settings/team', label: 'Team', icon: Users, managerOnly: true },
]

export function Sidebar({ isManager }: { isManager: boolean }) {
  const pathname = usePathname()
  const items = NAV.filter((n) => !n.managerOnly || isManager)

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
