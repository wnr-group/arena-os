import Link from 'next/link'
import { ArenaLogo } from '@/components/ui/ArenaLogo'
import type { MarketingViewer } from './viewer'

const PRODUCT = [
  { href: '/#features', label: 'Features' },
  { href: '/#industries', label: 'Industries' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
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
            <div className="flex items-center gap-2.5">
              <ArenaLogo className="h-9 w-auto shrink-0" />
              <span className="text-lg font-extrabold tracking-tight">Arena OS</span>
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

          <div>
            <p className={heading}>Account</p>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link href="/signup" className={link}>
                  Create your workspace
                </Link>
              </li>
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
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-2 border-t border-white/10 pt-6 text-xs text-white/45 sm:flex-row">
          <p>© {year} Arena OS. All rights reserved.</p>
          <p>Made for venues across India.</p>
        </div>
      </div>
    </footer>
  )
}
