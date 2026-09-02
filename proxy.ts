import { NextResponse, type NextRequest } from 'next/server'
import { tenantSlugFromHost } from '@/lib/tenant/subdomain'
import { SESSION_COOKIE } from '@/lib/auth/cookie'
import { CUSTOMER_SESSION_COOKIE } from '@/lib/auth/customer-cookie'
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

  // ── the customer portal (AROS-88) ─────────────────────────────────────────
  // The whole /account tree belongs to CUSTOMERS, not staff. /account/login is
  // its unauthenticated door; everything else behind it needs the customer
  // cookie. Computed here because both gates below have to agree on where the
  // boundary is — the staff gate must skip this tree, and the customer gate
  // must cover exactly it.
  const isCustomerLoginRoute =
    pathname === '/account/login' || pathname.startsWith('/account/login/')
  const isPortalRoute = pathname === '/account' || pathname.startsWith('/account/')
  // The public (no-login) tenant homepage ("/", app/page.tsx when a tenant
  // slug is present) and booking site — app/(public) — pinned to the tenant
  // by subdomain like every other tenant route, but deliberately reachable
  // with no session at all.
  const isPublicRoute =
    pathname === '/' ||
    pathname === '/food-menu' ||
    pathname === '/checkout' ||
    pathname === '/book' ||
    pathname.startsWith('/book/') ||
    pathname.startsWith('/book-type/') ||
    pathname.startsWith('/resources') ||
    pathname.startsWith('/b/') ||
    pathname.startsWith('/order/') ||
    // Order status tracking (M14 #7, v2) — /o/[orderId] is the no-login
    // status page a customer lands on right after checkout, /track is the
    // phone-lookup fallback to find it again later. Same "no session at all"
    // trust model as /b/[token] above.
    pathname.startsWith('/o/') ||
    pathname === '/track' ||
    // Customer OTP login (AROS-87). Public by definition: a customer signing in
    // has no session of EITHER kind yet.
    isCustomerLoginRoute

  const hasSession = request.cookies.has(SESSION_COOKIE)
  const hasCustomerSession = request.cookies.has(CUSTOMER_SESSION_COOKIE)

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

  /**
   * Gateway webhooks are machine-to-machine and carry no session cookie — a
   * redirect to /login would swallow every Razorpay delivery and silently lose
   * payments. They authenticate themselves with an HMAC signature instead (see
   * app/api/webhooks/razorpay/route.ts), so the cookie check must not apply.
   * The tenant slug header set above is exactly what those routes use to pick
   * which tenant's signing secret to verify against.
   */
  const isWebhook = pathname.startsWith('/api/webhooks/')

  // ── customer gate ─────────────────────────────────────────────────────────
  // Checked BEFORE the staff gate, and covering the /account tree exclusively.
  // Order matters: without this, a customer with no staff cookie would be sent
  // to the STAFF login, which they can never satisfy.
  //
  // Presence-only, deliberately. This function never touches the database (see
  // the note at the top of the file), so it cannot tell a valid cookie from a
  // forged or expired one — that is PortalLayout's job via requireCustomer(),
  // which validates the session against customer_sessions and its tenant. All
  // this does is spare the signed-out an unnecessary render.
  //
  // A staff cookie is NOT accepted here, and the customer cookie is NOT
  // accepted by the staff gate below: they are different cookie names looked
  // up in different tables, so neither audience can borrow the other's session.
  if (slug && isPortalRoute && !isCustomerLoginRoute && !hasCustomerSession) {
    // The whole destination, query string included. `pathname` alone would drop
    // it, so a deep link like /account/bookings?tab=past came back from login as
    // the default view rather than the one the link pointed at.
    const destination = pathname + request.nextUrl.search

    const url = request.nextUrl.clone()
    url.pathname = '/account/login'
    // clone() carries the original query over too. Those params describe the
    // destination, not the login page, and they now travel inside `next` — so
    // clear them rather than leaving a confusing duplicate on the login URL.
    url.search = ''
    // So login can return them where they were headed. Validated on the far
    // end by safeCustomerNext() — never trusted as given.
    url.searchParams.set('next', destination)
    return NextResponse.redirect(url)
  }

  // Protected surfaces: tenant routes on a subdomain, and the platform admin
  // panel on the root domain. Membership/admin authorization is enforced deeper
  // (RLS + page guards); the proxy only bounces the signed-out.
  //
  // `!isPortalRoute` keeps the staff gate off the customer tree entirely — the
  // customer gate above is the only authority there.
  const needsSession =
    (slug || pathname.startsWith('/admin')) &&
    !isAuthRoute &&
    !isPublicRoute &&
    !isWebhook &&
    !isPortalRoute
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
