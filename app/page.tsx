import { CalendarDays, HandCoins, ChefHat, Boxes, Users, type LucideIcon } from 'lucide-react'
import { rootDomain } from '@/lib/tenant/subdomain'
import { MarketingNavbar } from '@/components/marketing/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'

const FEATURES: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: CalendarDays,
    title: 'Bookings',
    description: 'Real-time availability across every resource, with a mobile-first storefront customers book from directly.',
  },
  {
    icon: HandCoins,
    title: 'POS & billing',
    description: 'Take payments, apply happy hours and promo codes, and raise invoices without leaving the booking.',
  },
  {
    icon: ChefHat,
    title: 'Kitchen & food',
    description: 'Orders flow straight to a live kitchen queue, from menu item to KOT to table.',
  },
  {
    icon: Boxes,
    title: 'Resources & menu',
    description: 'Model every bookable resource and menu item your business runs, organized by type and category.',
  },
  {
    icon: Users,
    title: 'Staff & attendance',
    description: 'Rosters, clock-in/out, tasks and performance — all scoped to the right role.',
  },
]

/**
 * Platform landing page — served on the ROOT domain (e.g. arenaos.app), not on a
 * tenant subdomain. Tenants live at {slug}.{rootDomain}.
 */
export default function PlatformHome() {
  const domain = rootDomain()

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNavbar />

      <main className="flex-1">
        <section id="home" className="scroll-mt-16 border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-16 text-center sm:py-24">
            <div className="rounded-full border border-border px-4 py-1 text-xs font-medium text-muted-foreground">
              Smart Booking &amp; POS Platform
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Arena OS</h1>
            <p className="max-w-xl text-lg text-muted-foreground">
              One platform to run bookings, POS, food, staff and revenue — for gaming cafes, studios and experience
              centres. Every business gets its own subdomain and fully isolated data.
            </p>
            <p className="text-sm text-muted-foreground">
              Businesses sign in at{' '}
              <code className="rounded bg-muted px-1.5 py-0.5">your-business.{domain}</code>
            </p>
          </div>
        </section>

        <section id="features" className="scroll-mt-16">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
            <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">Everything one venue needs</h2>
            <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
              Every module below ships together — no add-ons to bolt on later.
            </p>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div
                  key={title}
                  className="group rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform duration-300 group-hover:scale-110">
                    <Icon size={18} />
                  </span>
                  <p className="mt-3 text-base font-semibold">{title}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter domain={domain} />
    </div>
  )
}
