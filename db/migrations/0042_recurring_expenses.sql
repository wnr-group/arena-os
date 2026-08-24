-- ============================================================================
-- Arena OS — 0034 recurring expenses + idempotent auto-generation (AROS-109)
--
-- A TEMPLATE table (recurring_expenses) plus two provenance columns on
-- `expenses`. A generated row is an ORDINARY expense — same table, same RLS,
-- same page, same reports — it merely records which template produced it and
-- for which period. Nothing downstream needs to know it was automated.
--
-- ── THE IDEMPOTENCY GUARANTEE ───────────────────────────────────────────────
-- `unique (recurring_expense_id, recurrence_period)`. That constraint, not an
-- application-level "does one already exist?" check, is what makes a second
-- run — or two concurrent runs — unable to bill August's rent twice. An
-- if-not-exists check in JS has a window between the SELECT and the INSERT that
-- two jobs can both pass through; a unique index has no such window.
--
-- Both columns are NULLABLE, and NULLs are DISTINCT to a unique index, so
-- hand-entered expenses (both null) never collide with each other. The paired
-- CHECK below stops a half-populated row claiming provenance it does not have.
-- ============================================================================

-- Only 'monthly' today (AROS-109 asks for no more). An enum rather than free
-- text so adding 'weekly' later is an ALTER TYPE, not a data migration — and so
-- a typo cannot silently create a cadence nothing processes.
do $$ begin
  create type public.expense_cadence as enum ('monthly');
exception when duplicate_object then null; end $$;

-- ── the month-end rule, in one place ────────────────────────────────────────
-- A template that says "day 31" must still run in February. The rule is: use
-- the requested day, or the month's LAST day when the month is shorter — never
-- skip the month, and never roll into the next one (a 31st that became March
-- 3rd would put February's rent in March's reports).
--
--   day 31 + 2026-02 → 2026-02-28      day 31 + 2028-02 → 2028-02-29 (leap)
--   day 31 + 2026-04 → 2026-04-30      day 15 + any     → the 15th
--
-- IMMUTABLE and pure date arithmetic: no timezone is involved, because a
-- calendar day is what the template means. Defined here so the job, any future
-- UI preview and any backfill all agree.
create or replace function public.recurring_expense_due_day(
  period_start date,
  day_of_month smallint
)
returns date
language sql immutable
as $$
  select period_start
       + (least(
            day_of_month::int,
            extract(day from (period_start + interval '1 month - 1 day'))::int
          ) - 1);
$$;

-- ── recurring_expenses ──────────────────────────────────────────────────────
create table if not exists public.recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  category_id   uuid not null,
  -- Nullable for the same reason expenses.vendor_id is: rent and salaries
  -- recur without a supplier to name.
  vendor_id     uuid,
  amount        numeric(10,2) not null check (amount >= 0),
  cadence       public.expense_cadence not null default 'monthly',
  day_of_month  smallint not null check (day_of_month between 1 and 31),
  -- The concrete due DATE of the next period to generate — already resolved
  -- through recurring_expense_due_day(), so the job compares dates and never
  -- recomputes the month-end rule to decide whether something is due.
  next_run      date not null,
  -- Copied onto every generated expense, so the Expenses list reads
  -- "Shop rent — Bandra" rather than a bare amount.
  note          text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Composite FKs, the device 0033 uses: tenant_id lives INSIDE the key, so a
  -- template can never point at another tenant's category or vendor. No delete
  -- rule on the category — deleting one a template depends on must fail loudly.
  constraint recurring_expenses_category_tenant_fkey
    foreign key (tenant_id, category_id)
    references public.expense_categories(tenant_id, id),

  constraint recurring_expenses_vendor_tenant_fkey
    foreign key (tenant_id, vendor_id)
    references public.vendors(tenant_id, id)
    on delete set null (vendor_id),

  -- Target of the composite (tenant_id, recurring_expense_id) FK on expenses.
  constraint recurring_expenses_tenant_id_key unique (tenant_id, id)
);

-- THE job's query: "active templates that are due", newest due first. Partial
-- on is_active because a disabled template is never scanned.
create index if not exists idx_recurring_expenses_due
  on public.recurring_expenses(next_run)
  where is_active;

create index if not exists idx_recurring_expenses_tenant
  on public.recurring_expenses(tenant_id, is_active);

drop trigger if exists trg_recurring_expenses_updated on public.recurring_expenses;
create trigger trg_recurring_expenses_updated before update on public.recurring_expenses
  for each row execute function public.set_updated_at();

-- ── expenses: provenance + the duplicate guard ──────────────────────────────
alter table public.expenses
  -- Which template produced this row. Null for a hand-entered expense.
  add column if not exists recurring_expense_id uuid,
  -- WHICH PERIOD it represents, as that period's first day (2026-08-01 for
  -- August). A date rather than a 'YYYY-MM' string so it sorts and compares
  -- like every other date in this schema, and so a future non-monthly cadence
  -- can reuse the column as "period start" unchanged.
  add column if not exists recurrence_period date;

do $$ begin
  alter table public.expenses
    add constraint expenses_recurring_tenant_fkey
    foreign key (tenant_id, recurring_expense_id)
    references public.recurring_expenses(tenant_id, id)
    -- Deleting a template leaves its history standing, unattributed: the money
    -- was still spent. Mirrors expenses → vendors.
    on delete set null (recurring_expense_id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.expenses
    -- Provenance is all-or-nothing: a row cannot claim a period without saying
    -- which template it came from, or vice versa.
    add constraint expenses_recurrence_paired
    check ((recurring_expense_id is null) = (recurrence_period is null));
exception when duplicate_object then null; end $$;

-- ── THE duplicate guard ─────────────────────────────────────────────────────
-- One generated expense per (template, period). NULLs are distinct, so this
-- constrains generated rows only and leaves manual entry untouched. The job
-- inserts with ON CONFLICT DO NOTHING against exactly this constraint, which is
-- why a re-run and a concurrent run are both no-ops rather than errors.
create unique index if not exists idx_expenses_recurrence_period
  on public.expenses(recurring_expense_id, recurrence_period);

-- The "what did this template generate?" read.
create index if not exists idx_expenses_recurring
  on public.expenses(tenant_id, recurring_expense_id);

-- ── RLS + grants ────────────────────────────────────────────────────────────
-- Identical split to expenses (0033) and the menu tables: any active member of
-- the tenant may read, only owner/manager may write. The two policies are
-- permissive and OR together, so a cashier's SELECT is satisfied by the first
-- and their INSERT/UPDATE/DELETE reach only the second and are refused.
--
-- The generation job does NOT rely on these: it runs as the owner role, which
-- is RLS-exempt, exactly like migrations and scripts/refresh-reports.ts.
alter table public.recurring_expenses enable row level security;

drop policy if exists recurring_expenses_select on public.recurring_expenses;
create policy recurring_expenses_select on public.recurring_expenses
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists recurring_expenses_write on public.recurring_expenses;
create policy recurring_expenses_write on public.recurring_expenses
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.recurring_expenses to arena_app;
grant execute on function public.recurring_expense_due_day(date, smallint) to arena_app;
