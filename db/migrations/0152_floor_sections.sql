-- ============================================================================
-- Arena OS — 0152 Floor sections + server assignment (M20 / AROS-178)
--
-- Additive only. A restaurant floor is split into sections (Main dining,
-- Patio, Bar). Each table (a `resources` row) may belong to one section, and a
-- server (a membership) can be assigned to a whole section or to an individual
-- table (the table wins). When a party is seated, the effective server is
-- stamped on the session — `bookings.server_id` — so sales and tips can be
-- attributed to who actually worked the table (server-performance reporting,
-- tip-out). The stamp is a snapshot: later re-assigning a section never
-- rewrites history; mid-shift hand-offs move OPEN sessions explicitly.
--
-- Nothing changes for a restaurant with no sections / assignments: every new
-- column is nullable and the floor only groups when a section exists.
-- module.floor_sections entitlement: Pro/Enterprise.
-- ============================================================================

create table if not exists public.floor_sections (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete cascade,
  name               text not null check (length(btrim(name)) > 0),
  sort_order         integer not null default 0,
  -- Default server for every table in the section (a table-level override wins).
  assigned_server_id uuid references public.memberships(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint floor_sections_branch_name_key unique (branch_id, name)
);
create index if not exists idx_floor_sections_branch on public.floor_sections(tenant_id, branch_id, sort_order);

alter table public.resources
  add column if not exists section_id uuid references public.floor_sections(id) on delete set null,
  add column if not exists assigned_server_id uuid references public.memberships(id) on delete set null;
create index if not exists idx_resources_section on public.resources(section_id) where section_id is not null;

alter table public.bookings
  add column if not exists server_id uuid references public.memberships(id) on delete set null;
comment on column public.bookings.server_id is
  'The server who worked this table session (M20), stamped at seating from the table/section assignment and changeable by hand-off. Null when nobody was assigned.';
create index if not exists idx_bookings_server
  on public.bookings(tenant_id, server_id) where server_id is not null;

alter table public.floor_sections enable row level security;

drop policy if exists floor_sections_select on public.floor_sections;
create policy floor_sections_select on public.floor_sections
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Owner/manager shape the floor. Each command is its own policy (AROS-183).
drop policy if exists floor_sections_insert on public.floor_sections;
create policy floor_sections_insert on public.floor_sections
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists floor_sections_update on public.floor_sections;
create policy floor_sections_update on public.floor_sections
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists floor_sections_delete on public.floor_sections;
create policy floor_sections_delete on public.floor_sections
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.floor_sections to arena_app;

insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.floor_sections',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
