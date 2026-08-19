'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowRight, Menu, X } from 'lucide-react'

const NAV_LINKS = [
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

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** Sticky top nav for the tenant's public site — glass backdrop, a gradient
 * brand mark, animated-underline links, and an always-visible gradient
 * "Book Now" CTA. Links collapse behind a hamburger below `md`; the CTA
 * never does. Gains a shadow once the page scrolls past the hero. */
export function PublicNavbar({ tenantName, icon }: { tenantName: string; icon: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // "Menu" and "Resources" always live at their own route. Every other link
  // is a same-page anchor on the homepage — scroll to it directly when we're
  // already there, otherwise navigate back to the homepage anchor.
  const goTo = (id: string) => {
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
      className={`sticky top-0 z-40 border-b transition-all duration-300 ${
        scrolled
          ? 'border-border/80 bg-background/85 backdrop-blur-md shadow-[0_2px_20px_-8px_rgba(124,58,237,0.08),0_8px_30px_-12px_rgba(0,0,0,0.05)]'
          : 'border-transparent bg-background/60 backdrop-blur-sm'
      }`}
    >
      <div
        className={`mx-auto flex max-w-6xl items-center gap-3 px-4 transition-all duration-300 sm:px-6 ${
          scrolled ? 'py-2.5' : 'py-4'
        }`}
      >
        <div className="flex flex-1 justify-start min-w-0">
          <button type="button" onClick={() => goTo('home')} className="group flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-violet-500 text-primary-foreground shadow-lg shadow-primary/20 ring-2 ring-primary/10 transition-all duration-300 group-hover:scale-105 group-hover:shadow-primary/30 group-hover:rotate-3">
              {icon}
            </span>
            <span className="truncate text-lg font-extrabold tracking-tight bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent transition-all duration-300 group-hover:from-primary group-hover:to-primary-hover">
              {tenantName}
            </span>
          </button>
        </div>

        <nav className="hidden md:flex justify-center items-center gap-1">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={() => goTo(link.id)}
              className="group relative px-4 py-2 text-base font-semibold tracking-wide text-muted-foreground rounded-xl transition-all duration-200 hover:text-primary hover:bg-primary/5 active:scale-95"
            >
              {link.label}
              <span className="absolute bottom-1.5 left-4 right-4 h-[2px] origin-left scale-x-0 rounded-full bg-primary transition-transform duration-300 group-hover:scale-x-100" />
            </button>
          ))}
        </nav>

        <div className="flex flex-1 justify-end items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => router.push('/resources')}
            className="relative overflow-hidden inline-flex items-center gap-1.5 rounded-xl bg-primary hover:bg-primary-hover px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 sm:px-5 group"
          >
            {/* Shimmer overlay effect */}
            <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out" />
            
            <span>Book Now</span>
            <ArrowRight size={15} className="hidden sm:inline transition-transform duration-300 group-hover:translate-x-1" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground border border-border/60 bg-background/50 hover:bg-muted hover:text-primary transition-all duration-200 active:scale-95 md:hidden"
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
        <nav className="border-t border-border/80 bg-background/95 px-4 pb-5 pt-3 shadow-[0_15px_30px_-10px_rgba(0,0,0,0.1)] backdrop-blur-xl md:hidden animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex flex-col gap-1.5">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => {
                  setOpen(false)
                  goTo(link.id)
                }}
                className="group flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-semibold text-muted-foreground transition-all duration-150 hover:bg-primary/5 hover:text-primary active:scale-[0.98]"
              >
                <span>{link.label}</span>
                <span className="opacity-0 -translate-x-2 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 text-primary">
                  &rarr;
                </span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </header>
  )
}
