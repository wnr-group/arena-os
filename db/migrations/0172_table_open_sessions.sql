-- ============================================================================
-- Arena OS — 0172 let reservations see tables that are occupied right now
--
-- Seating a reservation (or a walk-in) turns it into a table session:
-- bookings.resource_id is set and there is NO booking_slots row, so the slot
-- exclusion constraint cannot see the table is taken. createReservationCore
-- therefore happily booked an overlapping party onto a table that was seated at
-- 7:00 for 7:45, and the public site offered it.
--
-- The reservation path has to look at open sessions itself. Staff can read
-- bookings; the anonymous storefront (public-tenant RLS context) cannot, and must
-- not see guest details. This returns only WHEN each table was occupied — no
-- names, phones or amounts — and only for the caller's own tenant, the same shape
-- as station_routing (0171).
-- ============================================================================

create or replace function public.table_open_sessions(p_tenant uuid, p_resources uuid[])
returns table(resource_id uuid, checked_in_at timestamptz, reserved_minutes integer)
language sql stable security definer set search_path = public
as $$
  select b.resource_id,
         coalesce(b.checked_in_at, b.created_at),
         b.reserved_minutes
    from public.bookings b
   where b.tenant_id = p_tenant
     and b.resource_id = any(p_resources)
     and b.status = 'checked_in'
     and (p_tenant = public.current_public_tenant_id()
          or p_tenant in (select public.auth_tenant_ids()))
$$;

revoke all on function public.table_open_sessions(uuid, uuid[]) from public;
grant execute on function public.table_open_sessions(uuid, uuid[]) to arena_app;
