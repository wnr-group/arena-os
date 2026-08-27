-- ============================================================================
-- Arena OS — 0054 order status notifications (M14 #7, v2): a customer's
-- explicit, revisable opt-in for "your order is ready" texts, and a minimal
-- notifications outbox recording every attempt (sent/skipped/failed).
--
-- No real SMS/WhatsApp provider is wired into this codebase yet (see
-- docs/ROADMAP.md's M3-C, still unbuilt) — this table exists so the
-- order-ready trigger has somewhere honest to record "would have sent, but
-- no provider is configured" without inventing a fake integration. Schema
-- is deliberately forward-compatible with M3-C's eventual outbox design.
-- ============================================================================

alter table public.customers
  add column if not exists notify_order_ready boolean not null default true;

-- Public checkout needs to persist a customer's opt-in choice on every order
-- (they may change their mind order to order), which is an UPDATE — no
-- customers_public_update policy existed before this (0023_public_booking_
-- create.sql only ever needed select+insert). Same tenant-only scope as that
-- migration's select/insert policies: RLS is the tenant boundary, and the
-- application code (lib/customers/service.ts's setNotifyOrderReady) is what
-- actually restricts this to touching only the notify_order_ready column of
-- the one customer row the caller just resolved by phone.
drop policy if exists customers_public_update on public.customers;
create policy customers_public_update on public.customers
  for update using (tenant_id = public.current_public_tenant_id())
             with check (tenant_id = public.current_public_tenant_id());

do $$ begin
  create type public.notification_channel as enum ('sms');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_status as enum ('sent', 'skipped', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_id         uuid references public.customers(id) on delete set null,
  order_id            uuid references public.orders(id) on delete set null,
  channel             public.notification_channel not null,
  kind                text not null,
  recipient_phone     text,
  message_body        text not null,
  status              public.notification_status not null,
  skip_reason         text,
  provider_message_id text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_notifications_order on public.notifications(tenant_id, order_id);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Staff/system-internal only (no public policy) — mirrors kots' "any active
-- member may read/create" shape (0013_kots.sql); nothing here is customer-facing.
alter table public.notifications enable row level security;

create policy notifications_select on public.notifications
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy notifications_insert on public.notifications
  for insert with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert on public.notifications to arena_app;
