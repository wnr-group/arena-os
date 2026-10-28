-- ============================================================================
-- Arena OS — 0173 table seat counts, per-phone reservation cap, idempotency
--
-- 1. resources.min_seats / max_seats — the party sizes a table takes. NULL means
--    "no limit on that side" (any party), so every existing table behaves as
--    before until an owner sets seats. Availability and assignment both match
--    on it, so a party of 12 is never put on a 2-top.
--
-- 2. open_reservations_for_phone() — how many future, unseated reservations a
--    phone already holds. The anonymous storefront cannot read bookings, so this
--    returns only a count (same shape as table_open_sessions, 0172).
--
-- 3. bookings.idempotency_key — a double-submitted public reservation resolves
--    to the booking the first submit created instead of a second one.
--    reservation_by_idempotency_key() hands the storefront just enough to
--    re-show that confirmation.
-- ============================================================================

alter table public.resources
  add column if not exists min_seats integer,
  add column if not exists max_seats integer;

alter table public.resources drop constraint if exists resources_seats_check;
alter table public.resources add constraint resources_seats_check check (
  (min_seats is null or min_seats between 1 and 100)
  and (max_seats is null or max_seats between 1 and 100)
  and (min_seats is null or max_seats is null or min_seats <= max_seats)
);

alter table public.bookings add column if not exists idempotency_key text;

create unique index if not exists bookings_idempotency_key_uniq
  on public.bookings (tenant_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.open_reservations_for_phone(p_tenant uuid, p_phone text)
returns integer
language sql stable security definer set search_path = public
as $$
  select count(*)::integer
    from public.bookings b
    join public.customers c on c.id = b.customer_id
   where b.tenant_id = p_tenant
     and c.phone = p_phone
     and b.reserved_for is not null
     and b.resource_id is null
     and b.status = 'confirmed'
     and b.reserved_for > now()
     and (p_tenant = public.current_public_tenant_id()
          or p_tenant in (select public.auth_tenant_ids()))
$$;

create or replace function public.reservation_by_idempotency_key(p_tenant uuid, p_key text)
returns table(booking_number text, confirmation_token text, reserved_for timestamptz, cover_count integer)
language sql stable security definer set search_path = public
as $$
  select b.booking_number, b.confirmation_token::text, b.reserved_for, b.cover_count
    from public.bookings b
   where b.tenant_id = p_tenant
     and b.idempotency_key = p_key
     and b.reserved_for is not null
     and p_tenant = public.current_public_tenant_id()
$$;

revoke all on function public.open_reservations_for_phone(uuid, text) from public;
revoke all on function public.reservation_by_idempotency_key(uuid, text) from public;
grant execute on function public.open_reservations_for_phone(uuid, text) to arena_app;
grant execute on function public.reservation_by_idempotency_key(uuid, text) to arena_app;
