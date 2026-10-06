import 'server-only'
import { getCurrentUser } from '@/lib/auth/session'

/** The signed-in visitor as the marketing chrome needs to know them, or null when signed out. */
export type MarketingViewer = { isPlatformAdmin: boolean } | null

/**
 * Resolves the viewer for the marketing navbar/footer/CTA. Uses the real session lookup (not just cookie
 * presence), and a failed lookup must never break a public marketing page, so it degrades to signed out.
 */
export async function getMarketingViewer(): Promise<MarketingViewer> {
  try {
    const user = await getCurrentUser()
    return user ? { isPlatformAdmin: user.isPlatformAdmin } : null
  } catch {
    return null
  }
}
