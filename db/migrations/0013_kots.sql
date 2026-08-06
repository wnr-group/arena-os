-- ============================================================================
-- Arena OS — 0013 kots: kitchen order tickets, one per order sent to the
-- kitchen, tracked through a status flow.
--
-- Operational table: any active member may read AND create (front-of-house
-- fires a KOT when an order is placed); only kitchen_staff/manager/owner may
-- advance its status (pending → preparing → ready → served, or cancelled).
-- ============================================================================

do $$ begin
  create type public.kot_status as enum ('pending','preparing','ready','served','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.kots (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  branch_id  uuid not null references public.branches(id) on delete restrict,
  order_id   uuid not null references public.orders(id) on delete cascade,
  kot_number text not null,
  status     public.kot_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, kot_number)
);
create index if not exists idx_kots_open on public.kots(tenant_id, branch_id, status);
drop trigger if exists trg_kots_updated on public.kots;
create trigger trg_kots_updated before update on public.kots
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.kots enable row level security;

-- read + create for any member; kitchen_staff/manager/owner may update status
create policy kots_select on public.kots
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy kots_insert on public.kots
  for insert with check (tenant_id in (select public.auth_tenant_ids()));
create policy kots_update on public.kots
  for update using (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'))
             with check (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'));

grant select, insert, update, delete on public.kots to arena_app;
