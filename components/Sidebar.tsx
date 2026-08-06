'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarDays, LayoutDashboard, Settings, Boxes, Clock, Users, UtensilsCrossed } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  { href: '/settings/resources', label: 'Resources', icon: Boxes, managerOnly: true },
  { href: '/settings/menu', label: 'Menu', icon: UtensilsCrossed, managerOnly: true },
  { href: '/settings/hours', label: 'Working Hours', icon: Clock, managerOnly: true },
  { href: '/settings/team', label: 'Team', icon: Users, managerOnly: true },
]

export function Sidebar({ isManager, collapsed }: { isManager: boolean; collapsed?: boolean }) {
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
            title={collapsed ? item.label : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
              active
                ? 'bg-primary text-primary-foreground shadow-md shadow-primary/10'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              collapsed && 'justify-center px-2',
            )}
          >
            <Icon size={18} className={cn('shrink-0 transition-transform duration-200 group-hover:scale-110')} />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        )
      })}
      {!collapsed && (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground/80 border border-dashed border-border/50">
          <Settings size={14} className="shrink-0 animate-spin-slow" />
          <span className="truncate">More modules coming</span>
        </div>
      )}
    </nav>
  )
}

