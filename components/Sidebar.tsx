'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2,
  CalendarDays,
  LayoutDashboard,
  Settings,
  Boxes,
  Clock,
  Users,
  UtensilsCrossed,
  HandCoins,
  ChevronDown,
  Contact,
  ChefHat,
  ScanLine,
  UserCog,
  CalendarCheck,
  CalendarClock,
  ListChecks,
  TrendingUp,
  BarChart3,
  Shapes,
  Package,
  Tags,
  ClipboardList,
  Percent,
  Timer,
  Ticket,
  Banknote,
  Wallet,
  Landmark,
  Receipt,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { canViewCustomers, isManager, isOwner, type MemberRole } from '@/lib/auth/roles'

/**
 * `can` gates an entry on the member's role. Omit it for surfaces every member
 * may reach (Dashboard, Bookings, Attendance). It is a PREDICATE rather than a
 * `managerOnly` flag because two modules have their own rule: Customers is open
 * to cashiers/receptionists/floor staff, and Business Profile is owner-only.
 *
 * Hiding an entry is convenience, never security — every page re-checks the
 * role, every server action guards itself, and RLS guards the tables.
 */
type NavChild = { href: string; label: string; icon?: LucideIcon; can?: (role: MemberRole) => boolean }
type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  can?: (role: MemberRole) => boolean
  children?: NavChild[]
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  { href: '/bookings/scan', label: 'Check-in Scan', icon: ScanLine },
  { href: '/customers', label: 'Customers', icon: Contact, can: canViewCustomers },
  {
    href: '/settings/resources',
    label: 'Resources',
    icon: Boxes,
    can: isManager,
    children: [
      { href: '/settings/resources/types', label: 'Resource Types', icon: Shapes },
      { href: '/settings/resources/units', label: 'Resources', icon: Package },
    ],
  },
  {
    href: '/menu',
    label: 'Menu',
    icon: UtensilsCrossed,
    can: isManager,
    children: [
      { href: '/menu/categories', label: 'Categories', icon: Tags },
      { href: '/menu/items', label: 'Items', icon: ClipboardList },
    ],
  },
  {
    href: '/settings/pricing',
    label: 'Pricing',
    icon: HandCoins,
    can: isManager,
    children: [
      { href: '/settings/tax-rates', label: 'Tax Rates', icon: Percent },
      { href: '/settings/happy-hours', label: 'Happy Hours', icon: Timer },
      { href: '/settings/promo-codes', label: 'Promo Codes', icon: Ticket },
    ],
  },
  { href: '/kitchen', label: 'Kitchen', icon: ChefHat },
  { href: '/settings/hours', label: 'Working Hours', icon: Clock, can: isManager },
  {
    href: '/employees',
    label: 'Employees',
    icon: Users,
    children: [
      { href: '/settings/team', label: 'Staff', icon: UserCog, can: isManager },
      { href: '/attendance', label: 'Attendance', icon: CalendarCheck },
      { href: '/roster', label: 'Roster', icon: CalendarClock },
      { href: '/tasks', label: 'Tasks', icon: ListChecks },
      { href: '/performance', label: 'Performance', icon: TrendingUp, can: isManager },
      { href: '/reports/employees', label: 'Employee Report', icon: BarChart3, can: isManager },
    ],
  },
  // Owner-only: compensation is more sensitive than general staff management (migrations 0027–0028).
  {
    href: '/settings/payroll',
    label: 'Payroll',
    icon: Banknote,
    can: isOwner,
    children: [
      { href: '/settings/payroll/salary-structures', label: 'Salary Structures', icon: Wallet },
      { href: '/settings/payroll/advances', label: 'Advances & Loans', icon: Landmark },
      { href: '/settings/payroll/runs', label: 'Payroll Runs', icon: Receipt },
    ],
  },
  // Owner-only: the business's legal identity (migration 0012).
  { href: '/settings/business', label: 'Business Profile', icon: Building2, can: isOwner },
]

function isChildActive(pathname: string, children: NavChild[]) {
  return children.some((c) => pathname === c.href || pathname.startsWith(c.href + '/'))
}

export function Sidebar({ role, collapsed }: { role: MemberRole; collapsed?: boolean }) {
  const pathname = usePathname()
  const items = useMemo(() => NAV.filter((n) => !n.can || n.can(role)), [role])
  const [openLabel, setOpenLabel] = useState<string | null>(
    () => items.find((n) => n.children && isChildActive(pathname, n.children))?.label ?? null,
  )

  useEffect(() => {
    const activeItem = items.find((n) => n.children && isChildActive(pathname, n.children))
    if (activeItem) {
      setOpenLabel(activeItem.label)
    }
  }, [pathname, items])

  return (
    <nav className="flex flex-col gap-1 p-3 flex-1 overflow-y-auto">
      {items.map((item) => {
        const Icon = item.icon

        if (item.children) {
          const visibleChildren = item.children.filter((c) => !c.can || c.can(role))
          if (visibleChildren.length === 0) return null
          const childActive = isChildActive(pathname, visibleChildren)
          if (collapsed) {
            return (
              <Link
                key={item.href}
                href={visibleChildren[0].href}
                title={item.label}
                className={cn(
                  'flex items-center justify-center rounded-lg px-2 py-2.5 text-sm font-medium transition-all duration-200',
                  childActive
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/10'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon size={18} className="shrink-0" />
              </Link>
            )
          }
          const open = openLabel === item.label
          return (
            <div key={item.href}>
              <button
                type="button"
                onClick={() => setOpenLabel(open ? null : item.label)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                  childActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon size={18} className="shrink-0" />
                <span className="flex-1 truncate text-left">{item.label}</span>
                <ChevronDown size={14} className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="ml-[1.15rem] mt-1 flex flex-col gap-1 border-l border-border pl-4">
                  {visibleChildren.map((child) => {
                    const active = pathname === child.href || pathname.startsWith(child.href + '/')
                    const ChildIcon = child.icon
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200',
                          active
                            ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/10'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {ChildIcon && <ChildIcon size={15} className="shrink-0" />}
                        <span className="truncate">{child.label}</span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        }

        const active = pathname === item.href || pathname.startsWith(item.href + '/')
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
