-- M35 #5: the stock check on the COMMIT path must see real reservations.
--
-- assertStock -> addonHeadroom -> reservedAddonUnits sums booking_addons. For
-- an online booking that statement runs as the public role, which (rightly)
-- cannot read booking_addons — so it always counted 0 and two anonymous
-- bookings could both take the last unit. 0110 fixed the display path only.
--
-- addon_reserved_units() returns the reserved count for ONE add-on, as a
-- SECURITY DEFINER, but only when the caller is authorised for that tenant:
-- either the public tenant of this transaction, or a member of the tenant
-- (auth_tenant_ids). Anyone else gets NULL, so the caller can fall back to a
-- plain RLS-governed query. It is called while the catalog row is locked
-- (FOR UPDATE), and being a per-statement snapshot in READ COMMITTED it sees
-- a racing transaction's committed rows once the lock is released.
-- Keep the status exclusion in step with STOCK_RELEASING_STATUSES.
create or replace function public.addon_reserved_units(
  p_tenant_id uuid,
  p_addon_id uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_exclude_slot_id uuid
)
returns integer
language plpgsql stable security definer set search_path = public
as $$
declare
  v_reserved integer;
begin
  if not (
    p_tenant_id = public.current_public_tenant_id()
    or p_tenant_id in (select public.auth_tenant_ids())
  ) then
    return null;
  end if;

  select coalesce(sum(ba.quantity), 0)::int
    into v_reserved
    from public.booking_addons ba
    join public.bookings b on b.id = ba.booking_id
   where ba.tenant_id = p_tenant_id
     and ba.addon_id = p_addon_id
     and b.status not in ('cancelled', 'no_show')
     and (ba.ends_at is null or ba.ends_at > p_starts)
     and (p_ends is null or ba.starts_at < p_ends)
     and (p_exclude_slot_id is null or ba.booking_slot_id <> p_exclude_slot_id);
  return v_reserved;
end;
$$;

grant execute on function public.addon_reserved_units(uuid, uuid, timestamptz, timestamptz, uuid) to arena_app;
