-- ============================================================================
-- Arena OS — 0032 public booking: read-only access for un-authenticated
-- visitors on a tenant subdomain (the online booking site).
--
-- Mirrors the staff isolation model in 0002_rls.sql, but for a caller with NO
-- app.user_id at all: the app pins exactly one tenant per request via
-- app.public_tenant_id (see withPublicTenant() in db/index.ts), and these
-- policies only ever expose what a stranger picking a slot needs — resource
-- catalogue, working hours, and booking_slots' time ranges. Never bookings
-- (customer name/phone/notes) and never any pricing column.
-- ============================================================================

create or replace function public.current_public_tenant_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.public_tenant_id', true), '')::uuid;
$$;

grant execute on function public.current_public_tenant_id() to arena_app;

drop policy if exists branches_public_select on public.branches;
create policy branches_public_select on public.branches
  for select using (
    tenant_id = public.current_public_tenant_id() and status = 'active'
  );

drop policy if exists resource_types_public_select on public.resource_types;
create policy resource_types_public_select on public.resource_types
  for select using (
    tenant_id = public.current_public_tenant_id() and is_active = true
  );

drop policy if exists resources_public_select on public.resources;
create policy resources_public_select on public.resources
  for select using (
    tenant_id = public.current_public_tenant_id() and status = 'available'
  );

drop policy if exists working_hours_public_select on public.working_hours;
create policy working_hours_public_select on public.working_hours
  for select using (tenant_id = public.current_public_tenant_id());

-- booking_slots: exposes starts_at/ends_at for the availability calculation.
-- rate_applied/slot_total are readable by RLS here too (RLS is row- not
-- column-scoped) but the public service (lib/booking/public-availability.ts)
-- never selects them — same discipline the staff-facing query already uses.
drop policy if exists booking_slots_public_select on public.booking_slots;
create policy booking_slots_public_select on public.booking_slots
  for select using (
    tenant_id = public.current_public_tenant_id() and active = true
  );

-- tenants: deliberately NOT a broad row policy. A "status in (...)" SELECT
-- policy would OR together with tenants_member_select and let EVERY caller —
-- staff included — enumerate every other tenant on the platform (this broke
-- scripts/verify-rls.ts: "demo owner sees exactly [demo]"). The subdomain
-- lookup instead goes through a SECURITY DEFINER function, same pattern as
-- auth_tenant_ids()/auth_role_in() below: it can read past RLS internally,
-- but only ever returns the ONE row matching the slug you already have.
drop policy if exists tenants_public_select on public.tenants;

create or replace function public.public_tenant_by_slug(p_slug text)
returns table (
  id uuid,
  slug text,
  name text,
  industry public.tenant_industry,
  currency text,
  timezone text
)
language sql stable security definer set search_path = public
as $$
  select id, slug, name, industry, currency, timezone
  from public.tenants
  where slug = p_slug and status in ('trial', 'active')
  limit 1;
$$;

grant execute on function public.public_tenant_by_slug(text) to arena_app;
