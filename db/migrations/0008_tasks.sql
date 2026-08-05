-- ============================================================================
-- Arena OS — 0008 tasks: manager-assigned staff tasks with status tracking
--
-- Operational table, same shape as attendance/shifts: any active member may
-- read/write (so an assignee can update their own task's status), with the
-- action layer restricting who may create/reassign/delete (managers) versus
-- just move status (the assignee, or a manager).
-- ============================================================================

do $$ begin
  create type public.task_status as enum ('open','in_progress','done');
exception when duplicate_object then null; end $$;

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete set null,
  title       text not null,
  description text,
  assigned_to uuid references public.memberships(id) on delete set null,
  status      public.task_status not null default 'open',
  due_date    date,
  created_by  uuid references public.memberships(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_tasks_assignee on public.tasks(assigned_to);
drop trigger if exists trg_tasks_updated on public.tasks;
create trigger trg_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.tasks enable row level security;

create policy tasks_rw on public.tasks
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.tasks to arena_app;
