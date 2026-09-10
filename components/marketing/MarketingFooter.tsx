import Link from 'next/link'
import { LayoutGrid } from 'lucide-react'

const NAV_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'features', label: 'Features' },
  { id: 'contact', label: 'Contact' },
]

export function MarketingFooter({ domain }: { domain: string }) {
  const year = new Date().getFullYear()

  return (
    <footer id="contact" className="scroll-mt-16 bg-primary text-primary-foreground">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-primary-foreground">
                <LayoutGrid size={18} />
              </span>
              <span className="text-base font-bold tracking-tight text-primary-foreground">Arena OS</span>
            </div>
            <p className="mt-3 text-sm text-primary-foreground/70">Smart Booking &amp; POS Platform</p>
          </div>

          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary-foreground/70">Quick links</p>
            <ul className="mt-3 space-y-2">
              {NAV_LINKS.map((link) => (
                <li key={link.id}>
                  <a href={`#${link.id}`} className="text-sm text-primary-foreground/80 transition hover:text-primary-foreground">
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <Link href="/login" className="text-sm text-primary-foreground/80 transition hover:text-primary-foreground">
                  Sign In
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary-foreground/70">Get started</p>
            <p className="mt-3 text-sm text-primary-foreground/80">
              Businesses sign in at{' '}
              <code className="rounded bg-white/15 px-1.5 py-0.5 text-xs text-primary-foreground">your-business.{domain}</code>
            </p>
          </div>
        </div>

        <div className="mt-10 border-t border-white/15 pt-6 text-center text-xs text-primary-foreground/70">
          © {year} Arena OS. All rights reserved.
        </div>
      </div>
    </footer>
  )
}
