import { rootDomain } from '@/lib/tenant/subdomain'

/**
 * Platform landing page — served on the ROOT domain (e.g. arenaos.app), not on a
 * tenant subdomain. Tenants live at {slug}.{rootDomain}. For now this is a simple
 * placeholder; tenant signup / marketing lands here later.
 */
export default function PlatformHome() {
  const domain = rootDomain()

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="rounded-full border px-4 py-1 text-xs font-medium text-muted-foreground">
        Smart Booking &amp; POS Platform
      </div>
      <h1 className="text-5xl font-bold tracking-tight">Arena OS</h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        One platform to run bookings, POS, food, staff and revenue — for gaming
        cafes, studios and experience centres. Every business gets its own
        subdomain and fully isolated data.
      </p>
      <p className="text-sm text-muted-foreground">
        Businesses sign in at{' '}
        <code className="rounded bg-muted px-1.5 py-0.5">your-business.{domain}</code>
      </p>
    </main>
  )
}
