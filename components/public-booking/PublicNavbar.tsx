'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowRight, Menu, ShoppingBag, X } from 'lucide-react'

/** "My Booking" is spliced in after "Resources" (only when myBookingHref is
 *  passed) rather than living here, since it isn't a fixed link — see
 *  buildNavLinks. */
const BASE_NAV_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'menu', label: 'Menu' },
  { id: 'resources', label: 'Resources' },
  { id: 'about', label: 'About' },
  { id: 'contact', label: 'Contact' },
]

/** Links that live at their own route rather than a homepage anchor. */
const ROUTES: Record<string, string> = {
  menu: '/food-menu',
  resources: '/resources',
}

function buildNavLinks(myBookingHref?: string, showMenuLink = true) {
  const base = showMenuLink ? BASE_NAV_LINKS : BASE_NAV_LINKS.filter((l) => l.id !== 'menu')
  if (!myBookingHref) return base
  // Spliced in right after "Resources" — findIndex rather than a fixed
  // offset, since showMenuLink=false shifts every later link left by one.
  const afterResources = base.findIndex((l) => l.id === 'resources') + 1
  return [...base.slice(0, afterResources), { id: 'my-booking', label: 'My Booking' }, ...base.slice(afterResources)]
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** The nav link id for the current route — "menu"/"resources"/"my-booking"
 *  live at their own route, so the active one is a straight pathname match.
 *  Anchor links (home/about/contact) only exist on "/" and are tracked by
 *  scroll position instead (see the IntersectionObserver below), so this
 *  returns null for them. */
function routeActiveId(pathname: string, myBookingHref?: string): string | null {
  if (myBookingHref && pathname === myBookingHref) return 'my-booking'
  const entry = Object.entries(ROUTES).find(([, route]) => route === pathname)
  return entry ? entry[0] : null
}

/** Sticky top nav for the tenant's public site — glass backdrop, a gradient
 * brand mark, animated-underline links, and an always-visible gradient
 * "Book Now" CTA. Links collapse behind a hamburger below `md`; the CTA
 * never does. Gains a shadow once the page scrolls past the hero. */
export function PublicNavbar({
  tenantName,
  icon,
  logoUrl,
  topOffset = 0,
  cartCount,
  onCartClick,
  myBookingHref,
  showMenuLink = true,
}: {
  tenantName: string
  icon: ReactNode
  logoUrl?: string | null
  /** Pixels to stick below instead of the viewport top — e.g. the staff preview banner above it. */
  topOffset?: number
  /** Item count shown as a badge on the cart button. Only meaningful together with onCartClick. */
  cartCount?: number
  /** When set, shows a cart button that opens the ordering cart — passed by OrderNavbar on any page with a cart (station order, /food-menu, homepage menu highlights). */
  onCartClick?: () => void
  /** When set, shows a "My Booking" button linking here — passed by OrderNavbar, to the phone-lookup hub where a customer finds their food orders and device bookings. */
  myBookingHref?: string
  /** False for a restaurant tenant's homepage/website — dine-in ordering
   *  happens via the table QR flow, not a general "browse the menu" nav
   *  link, so TenantHome/WebsitePage omit it there. Every other industry
   *  keeps it (default true). */
  showMenuLink?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [activeSection, setActiveSection] = useState('home')
  const router = useRouter()
  const pathname = usePathname()
  const navLinks = buildNavLinks(myBookingHref, showMenuLink)
  const activeId = routeActiveId(pathname, myBookingHref) ?? (pathname === '/' ? activeSection : null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Scroll-spy for the homepage's anchor sections (home/about/contact) —
  // route-based links (menu/resources/my-booking) are highlighted from
  // routeActiveId() above instead, since they never scroll into view here.
  useEffect(() => {
    if (pathname !== '/') return
    const ids = ['home', 'about', 'contact']
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (visible.length === 0) return
        const topmost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b))
        setActiveSection(topmost.target.id)
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    )
    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [pathname])

  // "My Booking" goes straight to the phone-lookup hub. "Menu" and
  // "Resources" always live at their own route. Every other link is a
  // same-page anchor on the homepage — scroll to it directly when we're
  // already there, otherwise navigate back to the homepage anchor.
  const goTo = (id: string) => {
    if (id === 'my-booking') {
      if (myBookingHref) router.push(myBookingHref)
      return
    }
    if (ROUTES[id]) {
      router.push(ROUTES[id])
      return
    }
    if (pathname === '/') {
      scrollToId(id)
      return
    }
    router.push(id === 'home' ? '/' : `/#${id}`)
  }

  return (
    <header
      style={{ top: topOffset }}
      className={`sticky z-40 bg-primary text-primary-foreground transition-shadow duration-300 ${
        scrolled ? 'shadow-md shadow-primary/25' : 'shadow-sm shadow-primary/10'
      }`}
    >
      <div
        className={`mx-auto flex max-w-7xl items-center gap-4 px-5 transition-all duration-300 sm:px-8 ${
          scrolled ? 'py-2.5' : 'py-4'
        }`}
      >
        <div className="flex flex-1 justify-start min-w-0">
          <button type="button" onClick={() => goTo('home')} className="group flex min-w-0 items-center gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={tenantName}
                className="size-10 shrink-0 rounded-xl object-cover shadow-lg shadow-primary/20 ring-2 ring-primary/10 transition-all duration-300 group-hover:scale-105"
              />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/15 text-primary-foreground shadow-lg shadow-primary/20 ring-2 ring-white/20 transition-all duration-300 group-hover:scale-105 group-hover:bg-white/20 group-hover:rotate-3">
                {icon}
              </span>
            )}
            <span className="truncate text-xl font-extrabold tracking-tight text-primary-foreground transition-opacity duration-300 group-hover:opacity-90">
              {tenantName}
            </span>
          </button>
        </div>

        <nav className="hidden md:flex justify-center items-center">
          {navLinks.map((link) => {
            const isActive = link.id === activeId
            return (
              <button
                key={link.id}
                type="button"
                onClick={() => goTo(link.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`group relative whitespace-nowrap px-2.5 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 hover:text-primary-foreground hover:bg-white/10 active:scale-95 lg:px-3.5 lg:text-base ${
                  isActive ? 'text-primary-foreground bg-white/10' : 'text-primary-foreground/75'
                }`}
              >
                {link.label}
                <span
                  className={`absolute bottom-1.5 left-2.5 right-2.5 h-[2px] origin-left rounded-full bg-white transition-transform duration-300 group-hover:scale-x-100 lg:left-3.5 lg:right-3.5 ${
                    isActive ? 'scale-x-100' : 'scale-x-0'
                  }`}
                />
              </button>
            )
          })}
        </nav>

        <div className="flex flex-1 justify-end items-center gap-2 shrink-0">
          {onCartClick && (
            <button
              type="button"
              onClick={onCartClick}
              aria-label="View cart"
              className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-primary-foreground transition-all duration-200 hover:border-white/30 hover:bg-white/20 active:scale-95"
            >
              <ShoppingBag size={18} />
              {!!cartCount && cartCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex min-w-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-primary shadow">
                  {cartCount > 99 ? '99+' : cartCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push('/resources')}
            className="relative overflow-hidden hidden md:inline-flex items-center gap-1.5 rounded-xl bg-white hover:bg-white/90 px-4 py-2.5 text-base font-semibold text-primary shadow-md shadow-primary/20 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 sm:px-6 group"
          >
            {/* Shimmer overlay effect */}
            <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-primary/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />

            <span>Book Now</span>
            <ArrowRight size={15} className="hidden sm:inline transition-transform duration-300 group-hover:translate-x-1" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-primary-foreground border border-white/20 bg-white/10 hover:bg-white/20 transition-all duration-200 active:scale-95 md:hidden"
          >
            {open ? (
              <X size={18} className="transition-transform duration-300 rotate-90" />
            ) : (
              <Menu size={18} className="transition-transform duration-300" />
            )}
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t border-white/15 bg-primary px-4 pb-5 pt-3 shadow-[0_15px_30px_-10px_rgba(0,0,0,0.25)] md:hidden animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex flex-col gap-1.5">
            {navLinks.map((link) => {
              const isActive = link.id === activeId
              return (
                <button
                  key={link.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    goTo(link.id)
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-semibold transition-all duration-150 hover:bg-white/10 hover:text-primary-foreground active:scale-[0.98] ${
                    isActive ? 'bg-white/10 text-primary-foreground' : 'text-primary-foreground/80'
                  }`}
                >
                  <span>{link.label}</span>
                  <span
                    className={`transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 text-primary-foreground ${
                      isActive ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'
                    }`}
                  >
                    &rarr;
                  </span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              router.push('/resources')
            }}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-white hover:bg-white/90 px-4 py-3 text-sm font-semibold text-primary shadow-md shadow-primary/20 transition-all duration-200 active:scale-[0.98]"
          >
            <span>Book Now</span>
            <ArrowRight size={15} />
          </button>
        </nav>
      )}
    </header>
  )
}
