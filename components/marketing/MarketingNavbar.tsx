'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LayoutDashboard, Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ArenaLogo } from '@/components/ui/ArenaLogo'
import type { MarketingViewer } from './viewer'

// Absolute `/#id` hrefs so the same bar works from /signup as well as the homepage.
const NAV_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/#industries', label: 'Industries' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
]

/** Sticky top nav for the platform's root marketing pages. Transparent at the top of the page, frosted glass once
 * scrolled. Sign in is shown on larger screens unless the visitor is signed in (a platform admin then gets an Admin panel button); links collapse behind a hamburger below `md`. */
export function MarketingNavbar({ viewer = null }: { viewer?: MarketingViewer } = {}) {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        'sticky top-0 z-50 transition-all duration-300',
        scrolled || open
          ? 'border-b border-border bg-background/80 shadow-sm backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-2.5" onClick={() => setOpen(false)}>
          <ArenaLogo className="h-9 w-auto shrink-0" />
          <span className="truncate text-lg font-extrabold tracking-tight">Arena OS</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {!viewer && (
            <Link
              href="/login"
              className="hidden rounded-lg px-4 py-2 text-sm font-semibold transition hover:bg-accent sm:inline-flex"
            >
              Sign in
            </Link>
          )}
          {viewer?.isPlatformAdmin && (
            <Link
              href="/admin"
              className="mk-shine inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/25 transition hover:-translate-y-0.5 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30"
            >
              <LayoutDashboard size={15} />
              Admin panel
            </Link>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg transition hover:bg-accent md:hidden"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t border-border px-4 pb-4 pt-2 md:hidden" aria-label="Mobile">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
            {!viewer && (
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-sm font-semibold transition hover:bg-accent"
              >
                Sign in
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  )
}
