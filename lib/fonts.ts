import { Plus_Jakarta_Sans, Inter } from 'next/font/google'

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

/**
 * The staff dashboard's typography is Helvetica Neue — a system font, not a
 * web font, so it can't be loaded here; it renders wherever the OS actually
 * has it (macOS/iOS) via the `--font-sans` stack in globals.css. Inter is
 * that stack's quality fallback for every OS that doesn't (Windows, Linux,
 * Android), loaded as a real web font so those users get more than Arial.
 * Exposed as a CSS variable (`.variable`, not `.className`) on the root
 * layout so it slots into `--font-sans` instead of forcing Inter on top of
 * Helvetica Neue where the latter IS available.
 */
export const dashboardFallbackFont = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})
