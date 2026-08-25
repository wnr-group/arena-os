import { Plus_Jakarta_Sans } from 'next/font/google'

/**
 * Scoped to the tenant-facing public site only (the customer homepage/hero,
 * booking flow, menu, resources) — not the staff dashboard, platform admin,
 * or the Arena OS marketing homepage, which keep the default font. Applied
 * via `.className` on the root of each public surface rather than touching
 * the global `--font-sans` in globals.css, so it never leaks into the rest
 * of the app.
 */
export const publicSiteFont = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
})
