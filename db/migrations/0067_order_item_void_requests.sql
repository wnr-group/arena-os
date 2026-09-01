-- ============================================================================
-- Arena OS — 0067: void/comp request/approval workflow
--
-- Revises M17 #6: a waiter REQUESTS a void or comp with a reason; a
-- manager/owner reviews it (table, item, amount, who asked, why) and
-- approves or rejects it. Only on APPROVAL does order_items.void_status
-- (0066) actually change — that's what loadFoodLines/loadOrderFoodLines
-- (lib/billing/invoice.ts) key off to keep the amount off the bill.
--
-- A manager/owner who requests their own void/comp is auto-approved in the
-- same transaction (lib/orders/service.ts's requestVoidOrderItemCore) — they
-- don't need to ask themselves for permission — so the pending queue only
-- ever holds requests raised by non-manager staff, and every accepted
-- void/comp still has exactly one request row underneath it either way,
-- keeping ONE code path and ONE trail for both cases.
--
-- One row per request, kept forever regardless of outcome (never deleted),
-- so the void/comp report (M20) can show the whole chain: who asked, why,
-- who decided, when. At most one PENDING request per item at a time (the
-- partial unique index below) — a second waiter can't double-request the
-- same line while one is already open; voidOrderItemCore's existing
-- FOR UPDATE lock on the order_item is what makes that check race-free.
-- ============================================================================

do $$ begin
  create type public.order_item_void_request_mode as enum ('void', 'comp');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.order_item_void_request_status as enum ('pending', 'approved', 'rejected');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.order_item_void_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  mode          public.order_item_void_request_mode not null,
  reason        text not null,
  status        public.order_item_void_request_status not null default 'pending',
  requested_by  uuid references public.memberships(id) on delete set null,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references public.memberships(id) on delete set null,
  decided_at    timestamptz,
  decision_note text
);

-- At most one open request per item — a second concurrent request collides
-- on this instead of silently queuing behind the first.
create unique index if not exists idx_order_item_void_requests_one_pending
  on public.order_item_void_requests(order_item_id)
  where status = 'pending';

-- The manager's approval queue: pending requests for the tenant, oldest first.
create index if not exists idx_order_item_void_requests_pending
  on public.order_item_void_requests(tenant_id, requested_at)
  where status = 'pending';

alter table public.order_item_void_requests enable row level security;

create policy order_item_void_requests_rw on public.order_item_void_requests
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

-- No delete grant: a decided request is kept forever, same append-mostly
-- discipline as audit_log, just with the one in-place transition
-- pending → approved/rejected that update covers.
grant select, insert, update on public.order_item_void_requests to arena_app;

comment on table public.order_item_void_requests is
  'Waiter-raised void/comp requests awaiting manager approval (M17 #6). Approval flips the linked order_items row (0066); rejection leaves it untouched.';
