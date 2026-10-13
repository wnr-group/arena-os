-- M35 #2: public add-on live stock.
--
-- The public catalog read already exists (0108 resource_type_addons_public_select,
-- active rows of the public tenant). What the anonymous role cannot do is count
-- reservations: booking_addons is deliberately NOT publicly readable (it holds
-- every booking's line items), so listAvailableAddons run as arena_app would
-- see zero reserved units and report every add-on as fully free.
--
-- public_addon_reserved_units() closes that without opening the table: a
-- SECURITY DEFINER function that returns ONLY a per-add-on reserved count, for
-- active add-ons of the current public tenant, never a row. Keep the status
-- exclusion in step with STOCK_RELEASING_STATUSES in lib/booking/addons.ts.
create or replace function public.public_addon_reserved_units(
  p_addon_ids uuid[],
  p_starts timestamptz,
  p_ends timestamptz
)
returns table (addon_id uuid, reserved integer)
language sql stable security definer set search_path = public
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

grant execute on function public.public_addon_reserved_units(uuid[], timestamptz, timestamptz) to arena_app;

-- lockAddonCatalog() (SELECT ... FOR UPDATE) runs inside the booking
-- transaction, and FOR UPDATE needs an UPDATE policy to pass (the 0109
-- lesson). Give the public role a lock-only one: USING lets it lock active
-- rows of its tenant, WITH CHECK (false) means it can never actually UPDATE.
-- The manager write policy and 0109's member lock policy are untouched.
drop policy if exists resource_type_addons_public_lock on public.resource_type_addons;
create policy resource_type_addons_public_lock on public.resource_type_addons
  for update using (tenant_id = public.current_public_tenant_id() and is_active = true)
          with check (false);
