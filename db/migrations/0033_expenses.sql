-- ============================================================================
-- Arena OS — 0033 expenses: categories, vendors, expense ledger (AROS-107)
--
-- Settings-shaped catalogues (expense_categories, vendors) plus the
-- transactional table that spends against them, the same split 0015_menu and
-- 0021_membership_plans use: any active member may READ, only owner/manager
-- may WRITE. Money is numeric(10,2) throughout — never a float — and reaches
-- the app as a string, like every other numeric in this schema.
--
-- Cross-table references use the composite (tenant_id, id) device that
-- 0010/0014/0017/0021/0026 established: FKs ignore RLS, so carrying tenant_id
-- INSIDE the key is what makes an expense pointing at another tenant's category
-- or vendor structurally impossible rather than merely unlikely.
-- ============================================================================

-- ── expense_categories ───────────────────────────────────────────────────────
-- The spend buckets: Rent, Utilities, Supplies, Maintenance, Salaries, Other.
-- Seeded by the tenant, not by this migration — the list above is the expected
-- shape, not a fixed vocabulary, so no enum and no pre-inserted rows.
create table if not exists public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite (tenant_id, category_id) FK expenses carries below.
  constraint expense_categories_tenant_id_key unique (tenant_id, id)
);

-- One live category per name per tenant, case-insensitively: 'Rent' and 'rent'
-- are the same bucket. Scoped to is_active like membership_plans (0021),
-- because a category with expenses against it is retired, never deleted, and
-- retiring the old Rent must not block creating a new one.
create unique index if not exists idx_expense_categories_active_name
  on public.expense_categories(tenant_id, lower(btrim(name)))
  where is_active;

-- The catalogue read: "the active categories for my tenant".
create index if not exists idx_expense_categories_tenant
  on public.expense_categories(tenant_id, is_active);

drop trigger if exists trg_expense_categories_updated on public.expense_categories;
create trigger trg_expense_categories_updated before update on public.expense_categories
  for each row execute function public.set_updated_at();

-- ── vendors ──────────────────────────────────────────────────────────────────
-- Suppliers an expense was paid to. Deliberately thin: a name plus how to reach
-- them. No address, GSTIN or payment terms — nothing needs them yet, and
-- business_profiles (0018) is where the tenant's own legal identity lives.
--
-- `phone` carries no E.164 check, unlike customers (0007): that constraint
-- exists because lib/customers/phone.ts normalises every write. There is no
-- such normaliser for vendors, so enforcing the shape here would reject
-- perfectly good landline/extension formats a supplier actually uses.
create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  phone      text,
  email      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite (tenant_id, vendor_id) FK expenses carries below.
  constraint vendors_tenant_id_key unique (tenant_id, id)
);

create unique index if not exists idx_vendors_active_name
  on public.vendors(tenant_id, lower(btrim(name)))
  where is_active;

create index if not exists idx_vendors_tenant
  on public.vendors(tenant_id, is_active);

drop trigger if exists trg_vendors_updated on public.vendors;
create trigger trg_vendors_updated before update on public.vendors
  for each row execute function public.set_updated_at();

-- ── expenses ─────────────────────────────────────────────────────────────────
-- One row per amount spent, on a day, in a category, optionally to a vendor.
--
-- `spent_on` is a plain DATE, not a timestamptz: an expense belongs to the day
-- the tenant says it does, and storing an instant would make that day depend on
-- a timezone conversion at read time. Same reasoning as v_daily_revenue.day.
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  category_id uuid not null,
  -- Nullable: rent and salaries are real expenses with no supplier to name.
  vendor_id   uuid,
  amount      numeric(10,2) not null check (amount >= 0),
  spent_on    date not null,
  note        text,
  receipt_url text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- No cascade on the category: deleting one that has been spent against must
  -- fail loudly rather than silently drop the spend history. Same rule
  -- customer_memberships (0026) applies to membership_plans.
  constraint expenses_category_tenant_fkey
    foreign key (tenant_id, category_id)
    references public.expense_categories(tenant_id, id),

  -- A deleted vendor leaves the expense standing, unattributed — the money was
  -- still spent. Mirrors invoices → customers (0014).
  constraint expenses_vendor_tenant_fkey
    foreign key (tenant_id, vendor_id)
    references public.vendors(tenant_id, id)
    on delete set null (vendor_id)
);

-- THE listing read: "this tenant's expenses, newest first".
create index if not exists idx_expenses_tenant_spent_on
  on public.expenses(tenant_id, spent_on desc);

-- Category and vendor drill-downs, and the lookups the two FKs above need.
create index if not exists idx_expenses_category
  on public.expenses(tenant_id, category_id);

create index if not exists idx_expenses_vendor
  on public.expenses(tenant_id, vendor_id);

drop trigger if exists trg_expenses_updated on public.expenses;
create trigger trg_expenses_updated before update on public.expenses
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- The standard business-table template from 0002_rls.sql, with the settings
-- split of 0015_menu: a `_select` policy any active member of the tenant
-- satisfies, and a `_write` policy only owner/manager satisfies. The two are
-- permissive and OR together, so a cashier can read but INSERT/UPDATE/DELETE
-- reach only the manager policy and are refused.
alter table public.expense_categories enable row level security;
alter table public.vendors            enable row level security;
alter table public.expenses           enable row level security;

drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists expense_categories_write on public.expense_categories;
create policy expense_categories_write on public.expense_categories
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists vendors_select on public.vendors;
create policy vendors_select on public.vendors
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists vendors_write on public.vendors;
create policy vendors_write on public.vendors
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists expenses_write on public.expenses;
create policy expenses_write on public.expenses
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.expense_categories to arena_app;
grant select, insert, update, delete on public.vendors            to arena_app;
grant select, insert, update, delete on public.expenses           to arena_app;
