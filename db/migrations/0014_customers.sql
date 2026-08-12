-- Arena OS — 0006 customers: customer directory + append-only ledgers

create table if not exists public.customers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  phone             text not null
                    -- E.164: '+' then 8–15 digits, no leading zero on the
                    -- country code. Enforces that only normalised phones land
                    -- here (see lib/customers/phone.ts).
                    check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name              text,
  email             text,
  dob               date,
  tags              text[] not null default '{}',
  membership_status text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- THE identity rule: one customer per phone per tenant. The same phone in a
  -- different tenant is a different customer row.
  unique (tenant_id, phone)
);
create index if not exists idx_customers_tenant on public.customers(tenant_id);
drop trigger if exists trg_customers_updated on public.customers;
create trigger trg_customers_updated before update on public.customers
  for each row execute function public.set_updated_at();

-- ── customer_notes ───────────────────────────────────────────────────────────
create table if not exists public.customer_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  body        text not null,
  created_by  uuid references public.memberships(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_customer_notes_customer on public.customer_notes(customer_id);

-- ── wallet_transactions (append-only ledger) ─────────────────────────────────
-- `amount` is SIGNED: positive = credit (top-up, refund), negative = debit
-- (paying with wallet). Balance = sum(amount). No balance column, by design.
create table if not exists public.wallet_transactions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount      numeric(10,2) not null,
  reason      text,
  source_type text,                       -- topup | booking | refund | adjustment …
  source_id   uuid,                       -- the invoice/booking that caused it
  created_by  uuid references public.memberships(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_wallet_tx_customer on public.wallet_transactions(customer_id);

-- ── loyalty_transactions (append-only ledger) ────────────────────────────────
-- `points` is SIGNED: positive = earned, negative = redeemed.
-- Balance = sum(points). No points-total column, by design.
create table if not exists public.loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  points      integer not null,
  reason      text,
  source_type text,
  source_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_loyalty_tx_customer on public.loyalty_transactions(customer_id);

-- ============================================================================
-- RLS + grants — the standard business-table template from 0002_rls.sql.
-- Customers are OPERATIONAL data (front-desk staff create them while booking),
-- so any active member may read and write; there is no manager-only split.
-- ============================================================================
alter table public.customers             enable row level security;
alter table public.customer_notes        enable row level security;
alter table public.wallet_transactions   enable row level security;
alter table public.loyalty_transactions  enable row level security;

drop policy if exists customers_rw on public.customers;
create policy customers_rw on public.customers
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists customer_notes_rw on public.customer_notes;
create policy customer_notes_rw on public.customer_notes
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists wallet_transactions_rw on public.wallet_transactions;
create policy wallet_transactions_rw on public.wallet_transactions
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists loyalty_transactions_rw on public.loyalty_transactions;
create policy loyalty_transactions_rw on public.loyalty_transactions
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.customers            to arena_app;
grant select, insert, update, delete on public.customer_notes       to arena_app;
grant select, insert, update, delete on public.wallet_transactions  to arena_app;
grant select, insert, update, delete on public.loyalty_transactions to arena_app;
