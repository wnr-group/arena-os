import { NextResponse, type NextRequest } from 'next/server'
import { tenantSlugFromHost } from '@/lib/tenant/subdomain'
import { SESSION_COOKIE } from '@/lib/auth/cookie'
import { rateLimit } from '@/lib/security/rate-limit'
import { ipFromHeaders } from '@/lib/security/ip'

/**
 * Edge proxy (Next 16's renamed "middleware"). It is deliberately thin:
 *   1. resolve the tenant slug from the subdomain and forward it via header, and
 *   2. bounce visitors with no session cookie off protected tenant routes.
 *
 * It does NOT hit the database or validate the session — that is the page layer's
 * job (getCurrentUser / getActiveContext), and tenant isolation is guaranteed by
 * RLS at the data layer regardless of what the proxy does. A present-but-invalid
 * cookie is caught server-side on the next render.
 */
export function proxy(request: NextRequest) {
  const slug = tenantSlugFromHost(request.headers.get('host'))

  if (slug) {
    request.headers.set('x-tenant-slug', slug)
  }

  const { pathname } = request.nextUrl
  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/auth')
  // The public (no-login) tenant homepage ("/", app/page.tsx when a tenant
  // slug is present) and booking site — app/(public) — pinned to the tenant
  // by subdomain like every other tenant route, but deliberately reachable
  // with no session at all.
  const isPublicRoute =
    pathname === '/' ||
    pathname === '/food-menu' ||
    pathname.startsWith('/book') ||
    pathname.startsWith('/resources') ||
    pathname.startsWith('/b/')
  const hasSession = request.cookies.has(SESSION_COOKIE)

  // Coarse abuse gate (AROS-47): every write against the public booking site
  // — availability lookups, phone lookups, booking create — is a server
  // action POSTed back to its own page URL, so a per-IP cap on POSTs to the
  // public route group catches all of them in one place, before any of them
  // touch the database. This is deliberately loose (a real booking session
  // fires several of these calls); tighter, action-specific and per-phone
  // limits live next to createPublicBooking itself in
  // lib/actions/public-booking.ts, where the parsed body is available.
  if (request.method === 'POST' && isPublicRoute) {
    const ip = ipFromHeaders(request.headers)
    const check = rateLimit(`edge-public:${ip}`, 60, 60_000)
    if (!check.ok) {
      return new NextResponse('Too many requests. Please slow down and try again shortly.', {
        status: 429,
        headers: { 'Retry-After': String(check.retryAfterSeconds) },
      })
    }
  }

  // Protected surfaces: tenant routes on a subdomain, and the platform admin
  // panel on the root domain. Membership/admin authorization is enforced deeper
  // (RLS + page guards); the proxy only bounces the signed-out.
  const needsSession = (slug || pathname.startsWith('/admin')) && !isAuthRoute && !isPublicRoute
  if (needsSession && !hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return NextResponse.next({ request })
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
