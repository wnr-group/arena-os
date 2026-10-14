/**
 * Test support (M37 #2): let a fixture venue take far-future bookings.
 *
 * Since M37 the advance-booking window is enforced on the server and defaults
 * to 7 days, so a script that books weeks or years ahead (to stay clear of real
 * data) must say so explicitly — the same "this fixture is …" statement
 * entitleTenant() makes for plans. It does NOT weaken the check: the script
 * opts its own throwaway tenant into a longer window through the same
 * booking_settings table a real owner uses.
 */
type Query = (text: string, values?: unknown[]) => Promise<unknown>

export async function allowFarBookings(query: Query, tenantId: string, days = 365): Promise<void> {
  await query(
    `insert into public.booking_settings (tenant_id, max_advance_days) values ($1, $2)
     on conflict (tenant_id) do update set max_advance_days = excluded.max_advance_days`,
    [tenantId, days],
  )
}
