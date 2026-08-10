-- Arena OS — 0010 billing: invoices, line items, payments, refunds,
--                          per-tenant numbering and the audit log.

do $$ begin
  create type public.invoice_status as enum ('draft','issued','paid','void');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_method as enum ('cash','card','upi','online','wallet');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_status as enum ('pending','captured','failed','refunded');
exception when duplicate_object then null; end $$;


-- Target of the composite (tenant_id, booking_id) FK on invoices below, which
-- is what makes a cross-tenant invoice→booking link impossible (FKs ignore RLS).
-- `customers` got the same key in 0008. Guarded rather than dropped-and-added:
-- once that FK exists it depends on this constraint, so a re-run of DROP fails.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bookings'::regclass
       and conname  = 'bookings_tenant_id_key'
  ) then
    alter table public.bookings add constraint bookings_tenant_id_key unique (tenant_id, id);
  end if;
end $$;

-- ── invoices 
create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  branch_id       uuid not null references public.branches(id) on delete restrict,
  invoice_number  text not null,
  booking_id      uuid,
  customer_id     uuid,
  subtotal        numeric(10,2) not null default 0 check (subtotal  >= 0),
  discount        numeric(10,2) not null default 0 check (discount  >= 0),
  promo_code_id   uuid,
  tax_total       numeric(10,2) not null default 0 check (tax_total >= 0),
  tax_breakup     jsonb         not null default '[]'::jsonb,
  total           numeric(10,2) not null default 0 check (total     >= 0),
  status          public.invoice_status not null default 'draft',
  place_of_supply text,                       -- GST state code/name, snapshotted
  issued_at       timestamptz,                -- set when status leaves 'draft'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invoices_tenant_number_key unique (tenant_id, invoice_number),
  constraint invoices_tenant_id_key unique (tenant_id, id),
  constraint invoices_booking_tenant_fkey
    foreign key (tenant_id, booking_id) references public.bookings(tenant_id, id)
    on delete set null (booking_id),
  constraint invoices_customer_tenant_fkey
    foreign key (tenant_id, customer_id) references public.customers(tenant_id, id)
    on delete set null (customer_id)
);
create index if not exists idx_invoices_branch on public.invoices(tenant_id, branch_id);
drop trigger if exists trg_invoices_updated on public.invoices;
create trigger trg_invoices_updated before update on public.invoices
  for each row execute function public.set_updated_at();

-- ── invoice_items
create table if not exists public.invoice_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  invoice_id  uuid not null,
  kind        text not null check (kind in ('booking','food','membership','adjustment')),
  source_id   uuid,
  description text not null,
  qty         numeric(10,2) not null default 1 check (qty > 0),
  unit_price  numeric(10,2) not null default 0 check (unit_price >= 0),
  tax_rate    numeric(5,2)  not null default 0 check (tax_rate between 0 and 100), -- percent
  line_total  numeric(10,2) not null default 0 check (line_total >= 0),
  created_at  timestamptz not null default now(),
  constraint invoice_items_invoice_tenant_fkey
    foreign key (tenant_id, invoice_id) references public.invoices(tenant_id, id)
    on delete cascade
);
create index if not exists idx_invoice_items_invoice on public.invoice_items(invoice_id);

-- ── payments
create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  invoice_id         uuid not null,
  method             public.payment_method not null,
  amount             numeric(10,2) not null check (amount > 0),
  status             public.payment_status not null default 'pending',
  gateway            text,                    -- 'razorpay' … null for in-store tenders
  gateway_order_id   text,
  gateway_payment_id text,
  gateway_signature  text,
  collected_by       uuid references public.memberships(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint payments_tenant_id_key unique (tenant_id, id),
  constraint payments_invoice_tenant_fkey
    foreign key (tenant_id, invoice_id) references public.invoices(tenant_id, id)
    on delete cascade
);
create index if not exists idx_payments_invoice on public.payments(invoice_id);
drop trigger if exists trg_payments_updated on public.payments;
create trigger trg_payments_updated before update on public.payments
  for each row execute function public.set_updated_at();

-- ── refunds
create table if not exists public.refunds (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  payment_id uuid not null,
  amount     numeric(10,2) not null check (amount > 0),
  reason     text,
  created_by uuid references public.memberships(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint refunds_payment_tenant_fkey
    foreign key (tenant_id, payment_id) references public.payments(tenant_id, id)
    on delete cascade
);
create index if not exists idx_refunds_payment on public.refunds(payment_id);

-- ── sequences (per-tenant human-readable numbers)
create table if not exists public.sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind      text not null check (kind in ('booking','invoice','kot')),
  period    text not null,
  value     integer not null default 0 check (value >= 0),
  primary key (tenant_id, kind, period)
);

-- ── audit_log 
create table if not exists public.audit_log (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  actor_membership_id uuid references public.memberships(id) on delete set null,
  action              text not null,
  entity_type         text not null,
  entity_id           uuid,
  "before"            jsonb,
  "after"             jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists idx_audit_log_tenant_created
  on public.audit_log(tenant_id, created_at desc);

-- RLS + grants — the standard business-table template from 0002_rls.sql.
alter table public.invoices      enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments      enable row level security;
alter table public.refunds       enable row level security;
alter table public.sequences     enable row level security;
alter table public.audit_log     enable row level security;


drop policy if exists invoices_rw on public.invoices;
create policy invoices_rw on public.invoices
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists invoice_items_rw on public.invoice_items;
create policy invoice_items_rw on public.invoice_items
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists payments_rw on public.payments;
create policy payments_rw on public.payments
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

-- Refunds are money leaving the till: every member may SEE them, only
-- owner/manager may write one (permissions matrix, ARCHITECTURE.md §3).
drop policy if exists refunds_member_select on public.refunds;
create policy refunds_member_select on public.refunds
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists refunds_manager_write on public.refunds;
create policy refunds_manager_write on public.refunds
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Numbering counters: tenant-scoped like any other business row.
drop policy if exists sequences_rw on public.sequences;
create policy sequences_rw on public.sequences
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

-- Audit entries are append-only: read + insert policies only, so no policy can
-- ever authorise an update or a delete of the trail.
drop policy if exists audit_log_tenant_select on public.audit_log;
create policy audit_log_tenant_select on public.audit_log
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists audit_log_tenant_insert on public.audit_log;
create policy audit_log_tenant_insert on public.audit_log
  for insert with check (tenant_id in (select public.auth_tenant_ids()));

-- Grants are the second lock: append-only tables never get update/delete, and
-- sequences never gets delete (a counter is reset by writing 0, not removed).
grant select, insert, update, delete on public.invoices      to arena_app;
grant select, insert, update, delete on public.invoice_items to arena_app;
grant select, insert, update, delete on public.payments      to arena_app;
grant select, insert                 on public.refunds       to arena_app;
grant select, insert, update         on public.sequences     to arena_app;
grant select, insert                 on public.audit_log     to arena_app;
