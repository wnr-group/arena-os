-- ============================================================================
-- Arena OS — 0021 membership_plans: the catalogue of plans a venue sells
--
-- Settings-shaped table, same split as tax_rates (0013) and promo_codes (0017):
-- any active member may READ a plan (the till has to price one at the counter),
-- only owner/manager may write, because a plan is money.
--
-- NOTE on naming: `memberships` in this schema is STAFF (a user's seat in a
-- tenant). This table is the CUSTOMER-facing product — Gold, Silver, …  The
-- purchase side (`customer_memberships`, AROS-60) is deliberately NOT created
-- here; this migration only builds the catalogue it will point at.
--
-- Benefits are STRUCTURED COLUMNS rather than a JSON blob on purpose: AROS-61
-- applies them during billing and must be able to read discount/free hours/
-- wallet credit without parsing anything.
-- ============================================================================

create table if not exists public.membership_plans (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  price            numeric(10,2) not null check (price >= 0),
  -- Months, not days: the products are "Gold — ₹2000 / 1 month". A purchase
  -- computes its own expiry from this, so the unit stays in one place.
  duration_months  integer not null check (duration_months > 0),
  -- ── benefits ──────────────────────────────────────────────────────────────
  discount_percent numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  free_hours       numeric(10,2) not null default 0 check (free_hours >= 0),
  wallet_credit    numeric(10,2) not null default 0 check (wallet_credit >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Target of the composite (tenant_id, plan_id) FK that customer_memberships
  -- will carry — the same device 0008/0010/0017 use for bookings, customers and
  -- promos, so a purchase can never reference ANOTHER tenant's plan.
  constraint membership_plans_tenant_id_key unique (tenant_id, id)
);

-- One live plan per name per tenant, case-insensitively: 'Gold' and 'gold' are
-- the same product. Scoped to `is_active` rather than a plain unique(tenant_id,
-- name), because plans are deactivated and kept for history — retiring the old
-- Gold must not block launching a new one.
create unique index if not exists idx_membership_plans_active_name
  on public.membership_plans(tenant_id, lower(btrim(name)))
  where is_active;

-- The catalogue read: "the active plans for my tenant".
create index if not exists idx_membership_plans_tenant
  on public.membership_plans(tenant_id, is_active);

drop trigger if exists trg_membership_plans_updated on public.membership_plans;
create trigger trg_membership_plans_updated before update on public.membership_plans
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.membership_plans enable row level security;

drop policy if exists membership_plans_select on public.membership_plans;
create policy membership_plans_select on public.membership_plans
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists membership_plans_write on public.membership_plans;
create policy membership_plans_write on public.membership_plans
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.membership_plans to arena_app;
