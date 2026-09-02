-- ============================================================================
-- Arena OS — 0057 order → kitchen (KOT) + staff incoming-orders queue: an
-- online order needs a staff accept/reject gate before it's cooked, and a
-- per-tenant auto-accept toggle so a venue that trusts the flow can skip it.
--
-- KOT creation itself needs no change — createOrderCore (lib/orders/service.ts)
-- already fires a KOT in the same transaction as the order for every channel
-- (0013_kots.sql). What's missing is a way to tell "cook this now" apart from
-- "a customer just placed this unattended, a human needs to say yes first":
-- acceptance_status, defaulting to 'accepted' so every existing row — and
-- every staff/POS order, which never goes through this gate — is unaffected.
--
-- No RLS change on orders/kots themselves: orders_rw (0012_orders.sql) and
-- kots_rw (0013_kots.sql) are row-scoped by tenant_id and already cover these
-- new columns; who may actually call accept/reject is an app-layer role check
-- (lib/auth/roles.ts), same as cancelOrder today.
-- ============================================================================

do $$ begin
  create type order_acceptance_status as enum ('pending', 'accepted', 'rejected');
exception when duplicate_object then null; end $$;

alter table public.orders
  add column if not exists acceptance_status order_acceptance_status not null default 'accepted';
alter table public.orders
  add column if not exists rejection_reason text;

-- The incoming-queue read (channel = 'online' and acceptance_status = 'pending')
-- and the kitchen read (require acceptance_status = 'accepted') both filter on
-- this pair per branch.
create index if not exists idx_orders_acceptance
  on public.orders(tenant_id, branch_id, acceptance_status)
  where channel = 'online';

-- ── auto-accept setting ──────────────────────────────────────────────────────
-- Shaped exactly like loyalty_settings (0039): tenant_id IS the primary key,
-- one row per tenant, no surrogate id. Off by default — a venue must opt in to
-- skipping the human accept/reject step for food a customer ordered unattended.
create table if not exists public.order_settings (
  tenant_id                  uuid primary key references public.tenants(id) on delete cascade,
  auto_accept_online_orders  boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

drop trigger if exists trg_order_settings_updated on public.order_settings;
create trigger trg_order_settings_updated before update on public.order_settings
  for each row execute function public.set_updated_at();

alter table public.order_settings enable row level security;

drop policy if exists order_settings_select on public.order_settings;
create policy order_settings_select on public.order_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists order_settings_write on public.order_settings;
create policy order_settings_write on public.order_settings
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Read by placeOnlineOrder (lib/actions/public-orders.ts) under the public/anon
-- RLS context, to decide whether a freshly placed order needs the accept/
-- reject gate at all — same justification as tax_rates_public_select (0056).
drop policy if exists order_settings_public_select on public.order_settings;
create policy order_settings_public_select on public.order_settings
  for select using (tenant_id = public.current_public_tenant_id());

grant select, insert, update on public.order_settings to arena_app;
