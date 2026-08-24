-- ============================================================================
-- Arena OS — 0029 payslips: the payroll run's output (AROS-104, M11 third
-- ticket — builds on 0027_salary_structures and 0028_employee_advances).
--
-- One row per (membership, period) — `period` is a calendar month, 'YYYY-MM'.
-- Every money/attendance figure here is a SNAPSHOT computed at run time from
-- salary_structures + attendance + employee_advances: a later salary-structure
-- edit, or an attendance correction for that month, must never rewrite a past
-- payslip, same discipline invoices (0018_billing.sql) apply to booking/menu
-- prices. allowances/deductions are copied verbatim from the salary structure
-- used, same SalaryComponent[] shape as that table — the "line breakdown" the
-- ticket asks for, without a separate items table: payroll's line count is
-- small and already jsonb everywhere else in this module.
--
-- unique (membership_id, period) is what makes a run IDEMPOTENT: the run
-- (lib/payroll/run.ts) pre-checks for an existing payslip in the period and
-- blocks the whole run with a clear error rather than upserting — upserting
-- would mean re-computing a period after payroll already posted advance
-- recoveries for it, which the recoveries ledger cannot un-post (it is
-- insert-only, see 0028). Blocking is the safe choice; the unique constraint
-- is the hard guarantee underneath it if two runs ever race.
--
-- net_pay carries a floor at 0 — see run.ts for why a payslip is never
-- allowed to print a negative number even in the (rare) case deductions
-- exceed a heavily-prorated attendance gross.
--
-- Owner-only RLS, same as salary_structures/employee_advances: compensation
-- data. Grants are select+insert ONLY, matching employee_advance_recoveries —
-- a payslip is a financial record of what was actually paid; correcting a
-- mistake means adjusting the NEXT run, never editing history.
-- ============================================================================

create table if not exists public.payslips (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  membership_id      uuid not null references public.memberships(id) on delete cascade,
  period             text not null check (period ~ '^\d{4}-\d{2}$'),
  -- Snapshot of the salary_structures row this payslip was computed from.
  base               numeric(10,2) not null,
  allowances         jsonb not null default '[]',
  deductions         jsonb not null default '[]',
  -- Attendance the gross was prorated against — see run.ts for the formula.
  days_in_period     smallint not null check (days_in_period > 0),
  days_present       smallint not null check (days_present >= 0),
  -- (base + sum(allowances)) * days_present / days_in_period, rounded.
  gross              numeric(10,2) not null check (gross >= 0),
  -- sum(deductions) — NOT prorated by attendance, a flat monthly figure.
  deductions_total   numeric(10,2) not null default 0 check (deductions_total >= 0),
  -- What this payslip actually recovered against the employee's advances,
  -- clamped by run.ts to both outstanding balance and what this payslip can
  -- afford — never larger than gross - deductions_total.
  advance_instalment numeric(10,2) not null default 0 check (advance_instalment >= 0),
  net_pay            numeric(10,2) not null default 0 check (net_pay >= 0),
  created_by         uuid references public.memberships(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (membership_id, period)
);
create index if not exists idx_payslips_tenant_period on public.payslips(tenant_id, period);
create index if not exists idx_payslips_member on public.payslips(membership_id);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.payslips enable row level security;

drop policy if exists payslips_owner_rw on public.payslips;
create policy payslips_owner_rw on public.payslips
  for all using (public.auth_role_in(tenant_id) = 'owner')
          with check (public.auth_role_in(tenant_id) = 'owner');

grant select, insert on public.payslips to arena_app;
