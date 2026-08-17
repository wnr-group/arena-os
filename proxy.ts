import { NextResponse, type NextRequest } from 'next/server'
import { tenantSlugFromHost } from '@/lib/tenant/subdomain'
import { SESSION_COOKIE } from '@/lib/auth/cookie'

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
    pathname.startsWith('/book') ||
    pathname.startsWith('/resources') ||
    pathname.startsWith('/b/')
  const hasSession = request.cookies.has(SESSION_COOKIE)

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
