/**
 * Subdomain / tenant-slug resolution shared by middleware and server code.
 *
 * A tenant is addressed as `{slug}.{rootDomain}` — e.g. acme.arenaos.app.
 * In local dev we use lvh.me (which resolves *.lvh.me to 127.0.0.1), so
 * acme.lvh.me:3000 works with no /etc/hosts edits.
 */

// Subdomains that are never a tenant (platform surfaces + infra).
export const RESERVED_SLUGS = new Set([
  'www',
  'app',
  'api',
  'admin',
  'auth',
  'assets',
  'static',
  'cdn',
  'mail',
  'blog',
  'help',
  'support',
  'status',
])

export function rootDomain(): string {
  return process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000'
}

/**
 * The full public URL for a path on a tenant's subdomain — e.g. the booking
 * confirmation page and its QR code, both of which need an absolute URL
 * rather than a relative path. http in dev (lvh.me:3000 has no TLS cert),
 * https everywhere else.
 */
export function publicTenantUrl(slug: string, path: string): string {
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'
  return `${protocol}://${slug}.${rootDomain()}${path}`
}

/**
 * Extract the tenant slug from a request host header. Returns null when the
 * host is the root domain itself (the platform / marketing site) or a reserved
 * subdomain.
 */
export function tenantSlugFromHost(host: string | null): string | null {
  if (!host) return null

  // Strip port, lowercase.
  const hostname = host.split(':')[0].toLowerCase()
  const root = rootDomain().split(':')[0].toLowerCase()

  // Exact root domain (or bare localhost) → platform, no tenant.
  if (hostname === root || hostname === 'localhost' || hostname === '127.0.0.1') {
    return null
  }

  if (!hostname.endsWith(`.${root}`)) {
    // Unknown host (e.g. a custom domain we don't map yet) → treat as platform.
    return null
  }

  const sub = hostname.slice(0, -1 * (`.${root}`.length))
  // Only the left-most label is the tenant slug; ignore deeper nesting.
  const slug = sub.split('.')[0]

  if (!slug || RESERVED_SLUGS.has(slug)) return null
  return slug
}
