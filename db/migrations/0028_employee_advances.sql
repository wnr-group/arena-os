-- ============================================================================
-- Arena OS — 0028 employee_advances: staff advances/loans + their recovery
-- ledger (AROS-85 / M11, second ticket — builds on 0027_salary_structures).
--
-- employee_advances is the PLAN — who was given how much, and the instalment
-- to recover each payroll period. employee_advance_recoveries is the LEDGER —
-- same append-only, signed-amount, no-stored-balance shape as
-- wallet_transactions/loyalty_transactions (0014_customers.sql): outstanding
-- is always `amount - sum(recoveries.amount)`, never a stored column, so it
-- can never drift out of sync with the rows that produced it. Recovery rows
-- are meant to be written by the payroll run (AROS-104) as it deducts each
-- period's instalment from a payslip — this ticket only builds the plan side
-- and the read path (outstanding balance), not a manual "record a repayment"
-- form, matching the ticket's scope.
--
-- Unlike wallet/loyalty (granted full CRUD despite the "append-only" comment),
-- the recoveries ledger here is granted select+insert ONLY — the same
-- structural enforcement refunds (0018_billing.sql) uses — because a
-- payroll-deduction record is closer to a refund than a wallet top-up: it
-- must never be editable after the fact, only reversed with a new
-- negative-amount correction row.
--
-- Owner-only RLS on both tables, same reasoning as salary_structures: this is
-- compensation data.
-- ============================================================================

create table if not exists public.employee_advances (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  membership_id     uuid not null references public.memberships(id) on delete cascade,
  amount            numeric(10,2) not null check (amount > 0),
  -- Deducted per payroll period until the advance is repaid; the last
  -- instalment is whatever remains once outstanding < instalment_amount —
  -- that clamping is the payroll run's job (AROS-104), not stored here.
  instalment_amount numeric(10,2) not null check (instalment_amount > 0),
  note              text,
  given_at          date not null,
  created_by        uuid references public.memberships(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists idx_employee_advances_member on public.employee_advances(membership_id);

drop trigger if exists trg_employee_advances_updated on public.employee_advances;
create trigger trg_employee_advances_updated before update on public.employee_advances
  for each row execute function public.set_updated_at();

create table if not exists public.employee_advance_recoveries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  advance_id  uuid not null,
  -- Signed, like wallet/loyalty: positive = a normal recovery (reduces what's
  -- owed), negative = a correction of a prior row recorded in error. Never
  -- update or delete a row — post the opposite instead.
  amount      numeric(10,2) not null,
  source_type text,                       -- 'payroll' once AROS-104 writes these; null today
  source_id   uuid,                       -- the payslip that caused it, once payslips exist
  created_by  uuid references public.memberships(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint employee_advance_recoveries_advance_tenant_fkey
    foreign key (tenant_id, advance_id) references public.employee_advances(tenant_id, id)
    on delete cascade
);
create index if not exists idx_employee_advance_recoveries_advance on public.employee_advance_recoveries(advance_id);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.employee_advances           enable row level security;
alter table public.employee_advance_recoveries enable row level security;

drop policy if exists employee_advances_owner_rw on public.employee_advances;
create policy employee_advances_owner_rw on public.employee_advances
  for all using (public.auth_role_in(tenant_id) = 'owner')
          with check (public.auth_role_in(tenant_id) = 'owner');

drop policy if exists employee_advance_recoveries_owner_rw on public.employee_advance_recoveries;
create policy employee_advance_recoveries_owner_rw on public.employee_advance_recoveries
  for all using (public.auth_role_in(tenant_id) = 'owner')
          with check (public.auth_role_in(tenant_id) = 'owner');

grant select, insert, update, delete on public.employee_advances           to arena_app;
grant select, insert                 on public.employee_advance_recoveries to arena_app;
