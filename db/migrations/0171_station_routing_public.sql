-- ============================================================================
-- Arena OS — 0171 station routing for anonymous (online) orders
--
-- kitchen_stations is readable only by members of the tenant (kitchen_stations_
-- select, 0148). An online order is created under the public-tenant RLS context,
-- so its routing lookup saw ZERO stations and every online line was stored with
-- station_id = NULL: a Grill-only screen never showed it.
--
-- Rather than open the whole table (printer ids, sort order) to the anonymous
-- role, this returns just the routing map — id and name of the ACTIVE stations —
-- and only for the caller's own tenant: the public tenant of the request, or a
-- tenant the signed-in user belongs to. Staff and anonymous orders therefore
-- resolve routing through the very same function and cannot drift apart.
-- ============================================================================

create or replace function public.station_routing(p_tenant uuid)
returns table(id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.id, s.name
    from public.kitchen_stations s
   where s.tenant_id = p_tenant
     and s.is_active
     and (p_tenant = public.current_public_tenant_id()
          or p_tenant in (select public.auth_tenant_ids()))
$$;

revoke all on function public.station_routing(uuid) from public;
grant execute on function public.station_routing(uuid) to arena_app;
