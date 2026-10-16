-- ============================================================================
-- Arena OS — 0123 venue-wide advance-booking window (M37 #1)
--
-- How far ahead bookings can be made, for the public storefront AND the admin
-- future-booking wizard. One row per tenant, shaped like
-- booking_cancellation_settings (0047): tenant_id IS the primary key. A tenant
-- with no row behaves as 7 days (the reader supplies the default), so every
-- existing venue is unchanged until an owner opts in.
--
-- Stored as integer days so a custom value can be added later without a
-- migration; the app only offers the presets 7 / 30 / 90 / 180.
-- ============================================================================

create table if not exists public.booking_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- "N days" = bookable dates are today ... today + N - 1 in the tenant zone.
  max_advance_days integer not null default 7
    check (max_advance_days between 1 and 365),

  updated_at timestamptz not null default now(),
  updated_by uuid references public.memberships(id) on delete set null
);

drop trigger if exists trg_booking_settings_updated on public.booking_settings;
create trigger trg_booking_settings_updated
  before update on public.booking_settings
  for each row execute function public.set_updated_at();

alter table public.booking_settings enable row level security;

-- Staff of the tenant can read it.
drop policy if exists booking_settings_select on public.booking_settings;
create policy booking_settings_select on public.booking_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Only owner/manager write. USING and WITH CHECK are both spelled out (AROS-294):
-- WITH CHECK is what stops a manager of tenant A writing a row for tenant B.
drop policy if exists booking_settings_manager_insert on public.booking_settings;
create policy booking_settings_manager_insert on public.booking_settings
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists booking_settings_manager_update on public.booking_settings;
create policy booking_settings_manager_update on public.booking_settings
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists booking_settings_manager_delete on public.booking_settings;
create policy booking_settings_manager_delete on public.booking_settings
  for delete using (public.auth_is_manager(tenant_id));

-- The anonymous storefront must read the window to render its date picker and
-- to enforce it server-side. Read-only, and only the visited tenant's row —
-- the same shape as 0022 / 0100.
drop policy if exists booking_settings_public_select on public.booking_settings;
create policy booking_settings_public_select on public.booking_settings
  for select using (tenant_id = public.current_public_tenant_id());

grant select, insert, update, delete on public.booking_settings to arena_app;
