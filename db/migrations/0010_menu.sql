-- ============================================================================
-- Arena OS — 0010 menu: categories, items, happy hours
--
-- Settings-shaped tables, same split as resource_types/resources (0003): any
-- active member may read the menu, only owner/manager may write it.
-- menu_items.tax_rate_id references public.tax_rates (0009).
-- ============================================================================

do $$ begin
  create type public.menu_item_status as enum ('available','out_of_stock','hidden');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.discount_type as enum ('percentage','fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.menu_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
drop trigger if exists trg_menu_categories_updated on public.menu_categories;
create trigger trg_menu_categories_updated before update on public.menu_categories
  for each row execute function public.set_updated_at();

create table if not exists public.menu_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  category_id         uuid not null references public.menu_categories(id) on delete restrict,
  name                text not null,
  price               numeric(10,2) not null check (price >= 0),
  tax_rate_id         uuid references public.tax_rates(id) on delete set null,
  status              public.menu_item_status not null default 'available',
  image_url           text,
  happy_hour_eligible boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_menu_items_tenant on public.menu_items(tenant_id, category_id);
drop trigger if exists trg_menu_items_updated on public.menu_items;
create trigger trg_menu_items_updated before update on public.menu_items
  for each row execute function public.set_updated_at();

create table if not exists public.happy_hours (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  name           text not null,
  days_of_week   smallint[] not null default '{}', -- 0=Sun..6=Sat
  start_time     time not null,
  end_time       time not null,
  discount_type  public.discount_type not null,
  discount_value numeric(10,2) not null check (discount_value >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists trg_happy_hours_updated on public.happy_hours;
create trigger trg_happy_hours_updated before update on public.happy_hours
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.menu_categories enable row level security;
alter table public.menu_items      enable row level security;
alter table public.happy_hours     enable row level security;

create policy menu_categories_select on public.menu_categories
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy menu_categories_write on public.menu_categories
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

create policy menu_items_select on public.menu_items
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy menu_items_write on public.menu_items
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

create policy happy_hours_select on public.happy_hours
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy happy_hours_write on public.happy_hours
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.menu_categories to arena_app;
grant select, insert, update, delete on public.menu_items      to arena_app;
grant select, insert, update, delete on public.happy_hours     to arena_app;
