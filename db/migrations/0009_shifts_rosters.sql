-- ============================================================================
-- Arena OS — 0007 shifts & roster: weekly roster builder, staff shift assignment
--
-- A roster is one week (`week_start`, unique per branch) at a branch; a shift
-- assigns a membership to a shift type (morning/evening/night) on a date
-- within that roster. Operational tables: any active member may read/write
-- (so staff can see the whole roster), same shape as attendance/bookings —
-- the action layer restricts building/editing to managers.
-- ============================================================================

do $$ begin
  create type public.shift_type as enum ('morning','evening','night');
exception when duplicate_object then null; end $$;

create table if not exists public.rosters (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  branch_id  uuid not null references public.branches(id) on delete restrict,
  week_start date not null,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, week_start)
);
drop trigger if exists trg_rosters_updated on public.rosters;
create trigger trg_rosters_updated before update on public.rosters
  for each row execute function public.set_updated_at();

create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  branch_id     uuid not null references public.branches(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  roster_id     uuid references public.rosters(id) on delete set null,
  shift_date    date not null,
  type          public.shift_type not null,
  starts        time not null,
  ends          time not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_shifts_member_date on public.shifts(membership_id, shift_date);
drop trigger if exists trg_shifts_updated on public.shifts;
create trigger trg_shifts_updated before update on public.shifts
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.rosters enable row level security;
alter table public.shifts  enable row level security;

create policy rosters_rw on public.rosters
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));
create policy shifts_rw on public.shifts
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.rosters to arena_app;
grant select, insert, update, delete on public.shifts  to arena_app;
