import { publicSiteFont } from '@/lib/fonts'
import { MarketingNavbar } from './MarketingNavbar'
import { MarketingFooter } from './MarketingFooter'
import { getMarketingViewer } from './viewer'

/**
 * The navbar + footer frame shared by the marketing pages that sit beside the homepage (About, Contact). Resolves
 * the viewer once so both bars agree on Sign in vs Admin panel.
 */
export async function MarketingShell({ children }: { children: React.ReactNode }) {
  const viewer = await getMarketingViewer()

  return (
    <div className={`marketing-root flex min-h-screen flex-col overflow-x-clip bg-background ${publicSiteFont.className}`}>
      <MarketingNavbar viewer={viewer} />
      <main className="flex-1">{children}</main>
      <MarketingFooter viewer={viewer} />
    </div>
  )
}
