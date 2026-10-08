import Link from 'next/link'
import { ArenaLogo } from '@/components/ui/ArenaLogo'
import { ArenaWordmark } from './ui/ArenaWordmark'
import type { MarketingViewer } from './viewer'

const PRODUCT = [
  { href: '/#features', label: 'Features' },
  { href: '/#industries', label: 'Industries' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
]

const INDUSTRIES = ['Gaming cafés', 'Recording studios', 'Podcast studios', 'Dance studios', 'VR centres', 'Restaurants']

/** Footer for the marketing site: brand, product and industry links, sign-in/sign-up and the copyright line. */
export function MarketingFooter({ viewer = null }: { viewer?: MarketingViewer } = {}) {
  const year = new Date().getFullYear()
  const link = 'text-sm text-white/65 transition hover:text-white'
  const heading = 'text-xs font-bold uppercase tracking-[0.16em] text-white/45'

  return (
    <footer className="mk-dark">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <div className="group flex items-center gap-2.5">
              <ArenaLogo className="h-9 w-auto shrink-0" />
              <ArenaWordmark tone="dark" />
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/65">
              The smart booking and POS platform for venues that want to run smoother and grow faster.
            </p>
          </div>

          <div>
            <p className={heading}>Product</p>
            <ul className="mt-4 space-y-2.5">
              {PRODUCT.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={link}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className={heading}>Built for</p>
            <ul className="mt-4 space-y-2.5">
              {INDUSTRIES.map((i) => (
                <li key={i} className="text-sm text-white/65">
                  {i}
                </li>
              ))}
            </ul>
          </div>

          {(!viewer || viewer.isPlatformAdmin) && (
            <div>
              <p className={heading}>Account</p>
              <ul className="mt-4 space-y-2.5">
                {!viewer && (
                  <li>
                    <Link href="/login" className={link}>
                      Sign in
                    </Link>
                  </li>
                )}
                {viewer?.isPlatformAdmin && (
                  <li>
                    <Link href="/admin" className={link}>
                      Admin panel
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-2 border-t border-white/10 pt-6 text-xs text-white/45 sm:flex-row">
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <p>© {year} Arena OS. All rights reserved.</p>
            <Link href="/privacy" className="transition hover:text-white">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition hover:text-white">
              Terms &amp; Conditions
            </Link>
          </div>
          <p>Made for venues across India.</p>
          <p>
            Powered by <span className="font-semibold text-white/70">WnR Group</span>
          </p>
        </div>
      </div>
    </footer>
  )
}
