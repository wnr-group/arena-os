'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LayoutGrid, Menu, X } from 'lucide-react'

const NAV_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'features', label: 'Features' },
  { id: 'contact', label: 'Contact' },
]

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** Sticky top nav for the platform's root marketing page — brand mark,
 * anchor links to the page's own sections, and an always-visible "Sign In"
 * CTA. Links collapse behind a hamburger below `md`; Sign In never does.
 * Solid wine (`--primary`) rather than a pastel tint, so it reads as a
 * genuinely colored bar rather than a barely-there wash. */
export function MarketingNavbar() {
  const [open, setOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 bg-primary text-primary-foreground shadow-md shadow-primary/20">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <button type="button" onClick={() => scrollToId('home')} className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-primary-foreground">
            <LayoutGrid size={18} />
          </span>
          <span className="truncate text-base font-bold tracking-tight text-primary-foreground">Arena OS</span>
        </button>

        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={() => scrollToId(link.id)}
              className="text-sm font-medium text-primary-foreground/80 transition hover:text-primary-foreground"
            >
              {link.label}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/login"
            className="inline-flex items-center rounded-lg bg-white px-3 py-2 text-sm font-medium text-primary shadow-sm transition hover:bg-white/90 sm:px-4"
          >
            Sign In
          </Link>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-primary-foreground transition hover:bg-white/15 md:hidden"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t border-white/15 px-4 pb-4 pt-2 md:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => {
                  setOpen(false)
                  scrollToId(link.id)
                }}
                className="rounded-lg px-3 py-2.5 text-left text-sm font-medium text-primary-foreground/80 transition hover:bg-white/10 hover:text-primary-foreground"
              >
                {link.label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </header>
  )
}
