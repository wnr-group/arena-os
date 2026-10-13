-- ============================================================================
-- Arena OS — 0120: addon_reserved_units() really fails closed (review of 0112).
--
-- 0112 guarded the SECURITY DEFINER count with
--     if not ( p_tenant_id = current_public_tenant_id()
--              or p_tenant_id in (select auth_tenant_ids()) ) then return null;
-- but current_public_tenant_id() is NULL outside a public transaction, so for a
-- caller who is neither a member nor on a public tenant the test is
--     NOT (NULL OR false) = NOT NULL = NULL
-- and plpgsql treats a NULL condition as false: the guard did NOT fire and the
-- function returned a real count for ANY tenant id. It fails open for exactly
-- the callers it was meant to refuse.
--
-- Each side is now coalesced to false, and a NULL tenant id is refused
-- outright, so every unauthorised call returns NULL. lib/booking/addons.ts
-- reservedAddonUnits already treats NULL as "not authorised" and falls back to
-- a plain RLS-governed sum, which is what the owner connection (the webhook's
-- late-payment stock re-check) needs.
--
-- Both functions also pin `search_path = public, pg_temp` (SECURITY DEFINER
-- hardening). public_addon_reserved_units (0110) is re-stated with that change
-- ONLY — its tenant scoping (a.tenant_id = current_public_tenant_id()) is an
-- equality in a WHERE clause, so NULL already yields no rows.
--
-- Grants are re-stated exactly as 0117 leaves them so this migration is
-- self-contained (create or replace keeps them, but do not depend on it).
-- ============================================================================

create or replace function public.addon_reserved_units(
  p_tenant_id uuid,
  p_addon_id uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_exclude_slot_id uuid
)
returns integer
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_reserved integer;
begin
  if p_tenant_id is null
     or not (
       coalesce(p_tenant_id = public.current_public_tenant_id(), false)
       or coalesce(p_tenant_id in (select public.auth_tenant_ids()), false)
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

create or replace function public.public_addon_reserved_units(
  p_addon_ids uuid[],
  p_starts timestamptz,
  p_ends timestamptz
)
returns table (addon_id uuid, reserved integer)
language sql stable security definer set search_path = public, pg_temp
as $$
  select a.id, coalesce(sum(ba.quantity), 0)::int
    from public.resource_type_addons a
    left join public.booking_addons ba
           on ba.addon_id = a.id
          and ba.tenant_id = a.tenant_id
          and (ba.ends_at is null or ba.ends_at > p_starts)
          and (p_ends is null or ba.starts_at < p_ends)
          and exists (
            select 1 from public.bookings b
             where b.id = ba.booking_id
               and b.status not in ('cancelled', 'no_show')
          )
   where a.id = any(p_addon_ids)
     and a.tenant_id = public.current_public_tenant_id()
     and a.is_active = true
   group by a.id;
$$;

revoke execute on function public.public_addon_reserved_units(uuid[], timestamptz, timestamptz) from public;
revoke execute on function public.addon_reserved_units(uuid, uuid, timestamptz, timestamptz, uuid) from public;

grant execute on function public.public_addon_reserved_units(uuid[], timestamptz, timestamptz) to arena_app;
grant execute on function public.addon_reserved_units(uuid, uuid, timestamptz, timestamptz, uuid) to arena_app;
