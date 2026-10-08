import type { Metadata } from 'next'
import Link from 'next/link'
import { publicSiteFont } from '@/lib/fonts'
import { ArenaLogo } from '@/components/ui/ArenaLogo'
import { ArenaWordmark } from '@/components/marketing/ui/ArenaWordmark'
import { NotFoundExperience } from '@/components/not-found/NotFoundExperience'

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false },
}

/**
 * The app-wide 404 — shown for any unknown URL and for every notFound() call (an unknown or suspended venue
 * subdomain, a root-only page opened on a venue's address, a missing record…). It is deliberately self-contained
 * and links only to "/" and the browser's history: it renders on the root domain AND on venue subdomains, where
 * pages like /about or /contact do not exist, so linking to them would just lead to another 404.
 */
export default function NotFound() {
  return (
    <div className={`marketing-root relative flex min-h-screen flex-col overflow-hidden bg-background ${publicSiteFont.className}`}>
      <div className="mk-grid-bg pointer-events-none absolute inset-0" />
      <div className="mk-blob pointer-events-none absolute -left-24 top-0 size-[24rem] rounded-full bg-primary/20 blur-3xl" />
      <div className="mk-blob pointer-events-none absolute -right-24 bottom-0 size-[22rem] rounded-full bg-[#d49a3a]/20 blur-3xl [animation-delay:-6s]" />

      <header className="relative">
        <div className="mx-auto flex max-w-7xl items-center px-4 py-4 sm:px-6">
          <Link href="/" className="group flex items-center gap-2.5">
            <ArenaLogo className="h-9 w-auto shrink-0" />
            <ArenaWordmark />
          </Link>
        </div>
      </header>

      <main className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-14">
        <NotFoundExperience />
      </main>
    </div>
  )
}
