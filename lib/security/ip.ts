/**
 * Best-effort caller IP from forwarding headers, for rate-limit keys only —
 * not for anything security-critical like auth. These headers are only as
 * trustworthy as the first hop that sets them (our own proxy.ts / the
 * hosting platform), not verified against the TCP connection. Takes a plain
 * Headers-like object (rather than calling next/headers itself) so it works
 * unchanged from both the edge proxy (NextRequest.headers) and server
 * actions (next/headers' headers()).
 */
export function ipFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = headers.get('x-real-ip')
  if (real) return real.trim()
  // No forwarding header at all (e.g. local dev) — share one bucket rather
  // than skipping the limit outright.
  return 'unknown'
}
