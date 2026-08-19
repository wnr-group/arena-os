import type { NextConfig } from 'next'

const isProd = process.env.NODE_ENV === 'production'

// Report-Only for now: the App Router streams RSC payloads through inline
// <script> tags with no nonce, which an *enforcing* script-src 'self' would
// block outright and break every page. Report-only surfaces real violations
// (browser devtools today; a report endpoint later) so we can add a nonce —
// via proxy.ts, since next.config.ts headers() can't vary per request —
// before ever flipping this to a blocking Content-Security-Policy header.
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    // Fast Refresh needs eval() in dev; never ship that to prod.
    `script-src 'self'${isProd ? '' : " 'unsafe-eval'"}`,
    // Next/Tailwind emit some inline <style>, and a couple of components use
    // the style={{}} attribute — both are governed by style-src, not just
    // script-src, so 'unsafe-inline' stays here even once script-src tightens.
    "style-src 'self' 'unsafe-inline'",
    // http://127.0.0.1:54321 is local Supabase storage — dev only, mirrors
    // the images.remotePatterns entry below.
    `img-src 'self' data: https://*.supabase.co https://*.neon.tech https://*.amazonaws.com${isProd ? '' : ' http://127.0.0.1:54321'}`,
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
  ]
  return directives.join('; ')
}

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Belt-and-suspenders with frame-ancestors above for browsers that predate it.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy() },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
]

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
  // The staff app is always reached on a tenant subdomain (demo.lvh.me:3000),
  // which Next treats as cross-origin to the dev server and blocks — so HMR
  // never connects and the browser silently keeps a stale page (including a
  // stale error overlay after a build failure). Allow the local wildcard host.
  allowedDevOrigins: ['lvh.me', '*.lvh.me', 'demo.lvh.me', 'localhost:3000'],
  experimental: {
    serverActions: {
      // lib/storage/s3.ts already caps uploaded images at 5MB (and says so in
      // the UI) — Next's own default (1MB) sat below that and silently
      // rejected the request before the upload actions ever ran. Leave
      // headroom above 5MB for multipart encoding overhead.
      bodySizeLimit: '6mb',
      // CSRF: every mutation in this app is a Server Action, and Next rejects
      // any Server Action POST whose Origin header doesn't match the request's
      // Host (a built-in, un-disableable check as long as allowedOrigins is
      // left unset, as it is here) — that alone blocks cross-site form/fetch
      // forgery. There are no app/**/route.ts POST handlers to separately
      // defend. The one exception is the future Razorpay webhook (AROS-50): a
      // server-to-server call with no browser Origin header to check, so it
      // will be a plain route.ts handler authenticated by signature
      // verification instead, not this Origin/Host check.
    },
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.neon.tech' },
      { protocol: 'https', hostname: '*.amazonaws.com' },
      {
        // Local Supabase storage during development
        protocol: 'http',
        hostname: '127.0.0.1',
        port: '54321',
        pathname: '/storage/v1/object/public/**',
      },
    ],
    dangerouslyAllowLocalIP: process.env.NODE_ENV === 'development',
    formats: ['image/webp', 'image/avif'],
  },
}

export default nextConfig
