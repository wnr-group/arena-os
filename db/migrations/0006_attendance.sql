-- ============================================================================
-- Arena OS — 0006 attendance: clock in/out per membership + manager corrections
--
-- One row per (membership, work_date) in the common case — a clock-in creates
-- it, a clock-out fills it in. Managers may back-fill or correct any row
-- (is_manual = true marks those). Not tied to booking/branch scheduling, so it
-- stays a simple operational table: any active member may read/write it, and
-- the action layer (not RLS) restricts staff to touching their own row.
-- ============================================================================

create table if not exists public.attendance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  branch_id     uuid not null references public.branches(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  work_date     date not null,
  clock_in      timestamptz,
  clock_out     timestamptz,
  is_manual     boolean not null default false,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_attendance_date   on public.attendance(tenant_id, work_date);
create index if not exists idx_attendance_member on public.attendance(membership_id);
drop trigger if exists trg_attendance_updated on public.attendance;
create trigger trg_attendance_updated before update on public.attendance
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.attendance enable row level security;

create policy attendance_rw on public.attendance
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.attendance to arena_app;
