-- ============================================================================
-- Arena OS — 0182 income: the "other income" ledger (M40 / AROS-357)
--
-- Cash coming into the business that is NOT a sale: owner investment, bank
-- interest, a vendor refund, an asset sale. Deliberately NOT revenue — see
-- lib/reports/revenue-basis.ts; only the P&L statement reads this table.
--
-- Shape mirrors `expenses` (0041) but smaller: no category, vendor, receipt,
-- recurrence, branch or created_by. `note` is the only "what is this" field.
-- Money is numeric(10,2); `received_on` is a plain DATE (the tenant's day, not
-- an instant), same reasoning as expenses.spent_on.
-- ============================================================================

create table if not exists public.income (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  amount      numeric(10,2) not null check (amount >= 0),
  received_on date not null,
  note        text check (note is null or length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- THE listing read: "this tenant's income, newest first".
create index if not exists idx_income_tenant_received_on
  on public.income(tenant_id, received_on desc);

drop trigger if exists trg_income_updated on public.income;
create trigger trg_income_updated before update on public.income
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Any active member may read; only owner/manager may write (same split as
-- expenses_select / expenses_write).
alter table public.income enable row level security;

drop policy if exists income_select on public.income;
create policy income_select on public.income
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists income_write on public.income;
create policy income_write on public.income
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.income to arena_app;
