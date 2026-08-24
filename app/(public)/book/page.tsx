import { redirect } from 'next/navigation'

/**
 * The tenant public homepage moved to "/" (see app/page.tsx). Kept as a
 * redirect so any bookmarked/shared /book links still land on the booking
 * section instead of 404ing. Tenant resolution + the unknown/suspended-tenant
 * 404 still happens in the (public) layout before this runs.
 */
export default function PublicBookingRedirect() {
  redirect('/#book')
}
