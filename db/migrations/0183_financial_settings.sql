-- ============================================================================
-- Arena OS — 0183 financial_settings: opening-balance reference (M40 / AROS-358)
--
-- One row per tenant (tenant_id IS the primary key), shaped like booking_settings
-- (0123). The opening balance is a one-time REFERENCE snapshot shown on the P&L —
-- it is not a ledger and never enters Net Profit. No row, or a null
-- opening_balance, means "not set".
--
-- Negative balances are allowed (an overdrawn opening position is real), so
-- there is deliberately no >= 0 check.
-- ============================================================================

create table if not exists public.financial_settings (
  tenant_id            uuid primary key references public.tenants(id) on delete cascade,
  opening_balance      numeric(12,2),
  opening_balance_as_of date,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.memberships(id) on delete set null
);

drop trigger if exists trg_financial_settings_updated on public.financial_settings;
create trigger trg_financial_settings_updated
  before update on public.financial_settings
  for each row execute function public.set_updated_at();

alter table public.financial_settings enable row level security;

drop policy if exists financial_settings_select on public.financial_settings;
create policy financial_settings_select on public.financial_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- USING and WITH CHECK both spelled out (AROS-294): WITH CHECK is what stops a
-- manager of tenant A writing a row for tenant B.
drop policy if exists financial_settings_manager_insert on public.financial_settings;
create policy financial_settings_manager_insert on public.financial_settings
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists financial_settings_manager_update on public.financial_settings;
create policy financial_settings_manager_update on public.financial_settings
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists financial_settings_manager_delete on public.financial_settings;
create policy financial_settings_manager_delete on public.financial_settings
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.financial_settings to arena_app;
