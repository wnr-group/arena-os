'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BadgeCheck,
  Ban,
  BadgeIndianRupee,
  Building2,
  CreditCard,
  Wallet,
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
  Gift,
  Scale,
  Landmark,
  Receipt,
  Calculator,
  PiggyBank,
  Globe,
  Bell,
  Armchair,
  Layers,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { canViewCustomers, canManageIncomingOrders, isManager, isOwner, type MemberRole } from '@/lib/auth/roles'

/**
 * `can` gates an entry on the member's role. Omit it for surfaces every member
 * may reach (Dashboard, Bookings, Attendance). It is a PREDICATE rather than a
 * `managerOnly` flag because two modules have their own rule: Customers is open
 * to cashiers/receptionists/floor staff, and Business Profile is owner-only.
 *
 * Hiding an entry is convenience, never security — every page re-checks the
 * role, every server action guards itself, and RLS guards the tables.
 */
type NavChild = {
  href: string
  label: string
  icon?: LucideIcon
  can?: (role: MemberRole) => boolean
  /** Same meaning as NavItem's industries below — omit for every industry. */
  industries?: string[]
}
type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  can?: (role: MemberRole) => boolean
  // M17: restricts an entry to specific tenant industries. Omit for every
  // entry every industry should see — every existing entry omits it, so a
  // gaming-cafe/studio tenant's nav is completely unaffected by this field
  // existing at all.
  industries?: string[]
  children?: NavChild[]
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  // Dine-in table service (M17) — restaurant tenants only.
  { href: '/floor', label: 'Tables', icon: Armchair, industries: ['restaurant'] },
  { href: '/bookings/scan', label: 'Check-in Scan', icon: ScanLine },
  { href: '/customers', label: 'Customers', icon: Contact, can: canViewCustomers },
  // The customer membership catalogue — manager-only, like Resources.
  { href: '/settings/memberships', label: 'Memberships', icon: BadgeCheck, can: isManager },
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
      // Modifier groups (M17 #8) — restaurant tenants only, same scoping as
      // Tables/Void-Comp Requests below.
      { href: '/menu/modifiers', label: 'Modifiers', icon: Layers, industries: ['restaurant'] },
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
      // The earn/redeem rule the till reads live (migration 0029). Grouped with
      // the other money rules because a redemption is a discount on the bill.
      // The page and the action each enforce manager/owner themselves — this
      // entry only decides what is worth showing.
      { href: '/settings/loyalty', label: 'Loyalty', icon: Gift },
    ],
  },
  // Per-tenant Razorpay credentials (migration 0022) — manager and owner only.
  { href: '/settings/payments', label: 'Payments', icon: CreditCard, can: isManager },
  // Website builder (M13/AROS-C) — manager and owner only, like the rest of settings.
  { href: '/settings/website', label: 'Website', icon: Globe, can: isManager },
  // Accept/reject queue for online orders (AROS M14 #4) — front-of-house
  // roles, not kitchen staff; see lib/auth/roles.ts's canManageIncomingOrders.
  { href: '/orders/incoming', label: 'Incoming Orders', icon: Bell, can: canManageIncomingOrders },
  // Void/comp approval queue (M17 #6) — manager/owner only: the request
  // itself is raised by front-of-house staff from the item's own void/comp
  // button, but approving it is money leaving the tab.
  // Void/comp (M17 #6) — restaurant tenants only, same scoping as Tables.
  { href: '/orders/void-requests', label: 'Void/Comp Requests', icon: Ban, can: isManager, industries: ['restaurant'] },
  { href: '/kitchen', label: 'Kitchen', icon: ChefHat },
  // Expense tracker (AROS-108) — manager/owner; the page and every mutation
  // enforce that themselves, the nav entry is convenience only.
  { href: '/expenses', label: 'Expenses', icon: Wallet, can: isManager },
  // Revenue & sales analytics (AROS-64/65) — manager/owner; the pages and their
  // data readers enforce that themselves, the nav entry is convenience only.
  {
    href: '/reports',
    label: 'Reports',
    icon: BarChart3,
    can: isManager,
    children: [
      { href: '/reports', label: 'Revenue & Bookings', icon: TrendingUp, can: isManager },
      { href: '/reports/sales', label: 'Food & Memberships', icon: UtensilsCrossed, can: isManager },
      // Revenue − expenses − payroll (AROS-86). The page redirects a non-manager
      // and getPnlReport() throws for one; this entry only decides visibility.
      { href: '/reports/pnl', label: 'Profit & Loss', icon: Scale, can: isManager },
    ],
  },
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
      // Self-service: payslips_self_select RLS (migration 0030) scopes this to
      // the viewer's own payslips; owner/manager see everyone's from here too.
      { href: '/payslips', label: 'My Payslips', icon: Receipt },
      { href: '/performance', label: 'Performance', icon: TrendingUp, can: isManager },
      { href: '/reports/employees', label: 'Employee Report', icon: BarChart3, can: isManager },
      { href: '/reports/payroll', label: 'Payroll Cost Report', icon: Calculator, can: isManager },
    ],
  },
  // Owner-only: compensation is more sensitive than general staff management (migrations 0027–0028).
  {
    href: '/settings/payroll',
    label: 'Payroll',
    icon: PiggyBank,
    can: isOwner,
    children: [
      { href: '/settings/payroll/salary-structures', label: 'Salary Structures', icon: Wallet },
      { href: '/settings/payroll/advances', label: 'Advances & Loans', icon: Landmark },
      { href: '/settings/payroll/runs', label: 'Payroll Runs', icon: Receipt },
    ],
  },
  // Owner-only: the business's legal identity (migration 0012).
  { href: '/settings/business', label: 'Business Profile', icon: Building2, can: isOwner },
  // Owner-only: what this business pays ARENA OS (M16 #5). Deliberately not
  // next to "Payments" above, which is the venue's own gateway for collecting
  // its customers' deposits — two different accounts, kept visibly apart.
  { href: '/settings/billing', label: 'Billing', icon: BadgeIndianRupee, can: isOwner },
]

/**
 * Does `href` own `pathname`? An exact hit, or a parent whose detail routes
 * should keep it lit — /customers stays current on /customers/<id>.
 */
function matchesHref(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/')
}

/**
 * The ONE href the sidebar highlights: the LONGEST match across every entry the
 * current role can see.
 *
 * Deciding this globally rather than per entry is the point. Some entries are
 * prefixes of their own siblings — /reports is both its own page ("Revenue &
 * Bookings") and the parent of /reports/sales and /reports/pnl, and /bookings
 * has the same relationship to /bookings/scan. Testing each entry on its own
 * meant the prefix rule above lit the parent alongside the page actually open,
 * leaving two items in the active state at once.
 *
 * Longest-match settles it: the most specific entry wins and every other goes
 * quiet, while a genuine detail route still falls back to its parent because
 * nothing longer matches it. It also keeps sibling groups honest —
 * /reports/employees belongs to Employees, so Reports no longer claims it.
 */
function resolveActiveHref(pathname: string, items: NavItem[], role: MemberRole): string | null {
  let best: string | null = null
  for (const item of items) {
    // A group's own href is never a link target (the header is a toggle), so
    // only its visible children can be the current entry.
    const hrefs = item.children
      ? item.children.filter((c) => !c.can || c.can(role)).map((c) => c.href)
      : [item.href]
    for (const href of hrefs) {
      if (matchesHref(pathname, href) && (best === null || href.length > best.length)) {
        best = href
      }
    }
  }
  return best
}

function isChildActive(activeHref: string | null, children: NavChild[]) {
  return children.some((c) => c.href === activeHref)
}

export function Sidebar({
  role,
  industry,
  collapsed,
}: {
  role: MemberRole
  industry: string
  collapsed?: boolean
}) {
  const pathname = usePathname()
  const items = useMemo(
    () =>
      NAV.filter((n) => (!n.can || n.can(role)) && (!n.industries || n.industries.includes(industry))),
    [role, industry],
  )
  const activeHref = useMemo(
    () => resolveActiveHref(pathname, items, role),
    [pathname, items, role],
  )
  const [openLabel, setOpenLabel] = useState<string | null>(
    () => items.find((n) => n.children && isChildActive(activeHref, n.children))?.label ?? null,
  )

  useEffect(() => {
    const activeItem = items.find((n) => n.children && isChildActive(activeHref, n.children))
    if (activeItem) {
      setOpenLabel(activeItem.label)
    }
  }, [activeHref, items])

  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
      {items.map((item) => {
        const Icon = item.icon

        if (item.children) {
          const visibleChildren = item.children.filter(
            (c) => (!c.can || c.can(role)) && (!c.industries || c.industries.includes(industry)),
          )
          if (visibleChildren.length === 0) return null
          const childActive = isChildActive(activeHref, visibleChildren)
          if (collapsed) {
            return (
              <Link
                key={item.href}
                href={visibleChildren[0].href}
                title={item.label}
                className={cn(
                  'flex items-center justify-center rounded-xl px-2 py-2.5 text-sm font-medium transition-[background-color,color] duration-[160ms] ease-[ease] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  childActive
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/10'
                    : 'text-[#6b4a52] hover:bg-[rgba(139,34,66,0.07)] hover:text-primary',
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
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-[background-color,color] duration-[160ms] ease-[ease] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  childActive
                    ? 'text-foreground'
                    : 'text-[#6b4a52] hover:bg-[rgba(139,34,66,0.07)] hover:text-primary',
                )}
              >
                <Icon size={18} className="shrink-0" />
                <span className="flex-1 truncate text-left">{item.label}</span>
                <ChevronDown
                  size={14}
                  className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
                />
              </button>
              {open && (
                <div className="ml-[1.15rem] mt-1 flex flex-col gap-1 border-l border-border pl-4">
                  {visibleChildren.map((child) => {
                    const active = child.href === activeHref
                    const ChildIcon = child.icon
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-[background-color,color] duration-[160ms] ease-[ease] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                          active
                            ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/10'
                            : 'text-[#7c5b63] hover:bg-[rgba(139,34,66,0.07)] hover:text-primary',
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

        const active = item.href === activeHref
        return (
          <Link
            key={item.href}
            href={item.href}
            title={collapsed ? item.label : undefined}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-[background-color,color] duration-[160ms] ease-[ease] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              active
                ? 'bg-primary text-primary-foreground shadow-md shadow-primary/10'
                : 'text-[#6b4a52] hover:bg-[rgba(139,34,66,0.07)] hover:text-primary',
              collapsed && 'justify-center px-2',
            )}
          >
            <Icon
              size={18}
              className={cn('shrink-0 transition-transform duration-200 group-hover:scale-110')}
            />
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
