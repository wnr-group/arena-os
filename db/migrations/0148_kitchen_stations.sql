-- ============================================================================
-- Arena OS — 0148 kitchen stations + expo (M19 / AROS-174)
--
-- Additive only; numbered after 0147 (renumber to the next free number at merge).
--
-- * kitchen_stations: per-tenant prep stations (Bar / Grill / Fryer / Cold …).
-- * menu_items.station_id / menu_categories.station_id: where a dish is made.
--   An item's own station wins; otherwise its category's; otherwise none.
-- * order_items.station_id / station_name: SNAPSHOT at order time, so routing of
--   an order already in the kitchen never changes when the menu mapping does.
-- * order_settings.stations_enabled (default false): opt-in. Off = no snapshot,
--   no station screens, exactly today's one-screen kitchen. KOTs stay one per
--   order — a "ticket on several stations" is the same KOT filtered by the
--   lines' station, so order-level status keeps working unchanged.
-- ============================================================================

alter table public.order_settings
  add column if not exists stations_enabled boolean not null default false;

create table if not exists public.kitchen_stations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists kitchen_stations_tenant_name_key
  on public.kitchen_stations(tenant_id, lower(btrim(name)));

drop trigger if exists trg_kitchen_stations_updated on public.kitchen_stations;
create trigger trg_kitchen_stations_updated before update on public.kitchen_stations
  for each row execute function public.set_updated_at();

alter table public.kitchen_stations enable row level security;

drop policy if exists kitchen_stations_select on public.kitchen_stations;
create policy kitchen_stations_select on public.kitchen_stations
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Managers/owners configure stations. Each command spelled out, USING + WITH
-- CHECK both present (AROS-183 / AROS-294 lessons).
drop policy if exists kitchen_stations_insert on public.kitchen_stations;
create policy kitchen_stations_insert on public.kitchen_stations
  for insert with check (public.auth_is_manager(tenant_id));
drop policy if exists kitchen_stations_update on public.kitchen_stations;
create policy kitchen_stations_update on public.kitchen_stations
  for update using (public.auth_is_manager(tenant_id)) with check (public.auth_is_manager(tenant_id));
drop policy if exists kitchen_stations_delete on public.kitchen_stations;
create policy kitchen_stations_delete on public.kitchen_stations
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.kitchen_stations to arena_app;

-- Deleting a station un-routes (set null) rather than blocking or cascading.
alter table public.menu_categories
  add column if not exists station_id uuid references public.kitchen_stations(id) on delete set null;
alter table public.menu_items
  add column if not exists station_id uuid references public.kitchen_stations(id) on delete set null;
alter table public.order_items
  add column if not exists station_id uuid references public.kitchen_stations(id) on delete set null,
  add column if not exists station_name text;

create index if not exists idx_order_items_station
  on public.order_items(tenant_id, station_id) where station_id is not null;

-- Parity: nothing is routed yet — existing lines must be untouched (null).
do $$
declare n bigint;
begin
  select count(*) into n from public.order_items where station_id is not null or station_name is not null;
  if n > 0 then
    raise exception '0148 parity: % order_items rows unexpectedly carry a station', n;
  end if;
end $$;
