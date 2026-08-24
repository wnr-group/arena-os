-- ============================================================================
-- Arena OS — 0009 tax_rates: named GST-style rates, applied to menu items
--
-- Settings-shaped table, same split as resource_types/resources (0003): any
-- active member may read, only owner/manager may write.
-- ============================================================================

create table if not exists public.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  percent    numeric(5,2) not null check (percent >= 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
drop trigger if exists trg_tax_rates_updated on public.tax_rates;
create trigger trg_tax_rates_updated before update on public.tax_rates
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.tax_rates enable row level security;

drop policy if exists tax_rates_select on public.tax_rates;
create policy tax_rates_select on public.tax_rates
  for select using (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists tax_rates_write on public.tax_rates;
create policy tax_rates_write on public.tax_rates
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.tax_rates to arena_app;
