-- Arena OS — 0011 promo codes: discount codes applied at billing.

do $$ begin
  create type public.discount_type as enum ('percentage','fixed');
exception when duplicate_object then null; end $$;

create table if not exists public.promo_codes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  code           text not null check (length(btrim(code)) > 0),
  discount_type  public.discount_type not null,
  discount_value numeric(10,2) not null check (discount_value >= 0),
  valid_from     timestamptz not null,
  valid_until    timestamptz not null,
  -- null = unlimited. A limit of 0 would mean "never usable", which is what
  -- is_active = false is for, so a limit must be positive when present.
  max_uses       integer check (max_uses is null or max_uses > 0),
  uses           integer not null default 0 check (uses >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint promo_valid_dates check (valid_until > valid_from),
  -- A percentage over 100 is always a typo (₹500 off entered as 500%). Fixed
  -- amounts stay unbounded; the discount is capped at the subtotal at billing.
  constraint promo_percentage_range
    check (discount_type <> 'percentage' or discount_value <= 100),
  -- Target of the composite (tenant_id, promo_code_id) FK on invoices below.
  constraint promo_codes_tenant_id_key unique (tenant_id, id)
);

-- THE identity rule: one code per tenant, case-insensitively. 'WELCOME10',
-- 'welcome10' and 'Welcome10' are the same code; the same string in another
-- tenant is a different promo.
create unique index if not exists idx_promo_code
  on public.promo_codes(tenant_id, upper(code));

drop trigger if exists trg_promo_updated on public.promo_codes;
create trigger trg_promo_updated before update on public.promo_codes
  for each row execute function public.set_updated_at();

-- `invoices.promo_code_id` already exists (migration 0010) as an unconstrained
-- uuid; this is the FK it was waiting for. Composite on (tenant_id, …) — the
-- same device 0008/0010 use for bookings and customers — so an invoice can
-- never reference ANOTHER tenant's promo. FKs are not subject to RLS, so the
-- tenant column is what makes cross-tenant linkage structurally impossible.
-- Guarded rather than dropped-and-added: a re-run of DROP would fail once
-- anything depends on it.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass
       and conname  = 'invoices_promo_fk'
  ) then
    alter table public.invoices
      add constraint invoices_promo_fk
      foreign key (tenant_id, promo_code_id)
      references public.promo_codes(tenant_id, id)
      on delete set null (promo_code_id);
  end if;
end $$;

-- RLS + grants — the settings-table template from 0002_rls.sql: every member
-- may READ a promo (the till has to resolve a code the customer quotes), but
-- only owner/manager may create or change one, because a promo is money off.
alter table public.promo_codes enable row level security;

drop policy if exists promo_select on public.promo_codes;
create policy promo_select on public.promo_codes
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists promo_write on public.promo_codes;
create policy promo_write on public.promo_codes
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.promo_codes to arena_app;

-- ── consuming one use ────────────────────────────────────────────────────────
-- Billing is "cashier and up", but promo_write above is manager-only, so a
-- cashier cannot UPDATE promo_codes to record a use — and RLS cannot grant
-- update on ONE column. This function is the narrow hole: it can only ever
-- add 1 to `uses`, and nothing else about the promo can be touched through it.
--
-- SECURITY DEFINER (owner) so it is exempt from promo_write, exactly like
-- auth_tenant_ids() in 0002 — and, like that function, it cannot leak, because
-- it filters on the CALLER's own tenants. Passing another tenant's id matches
-- no row.
--
-- The whole thing is ONE statement, which is what makes it race-free: the
-- UPDATE takes a row lock, and a concurrent caller re-evaluates
-- `uses < max_uses` against the committed row after that lock is released. Two
-- cashiers racing for the last use produce one winner and one empty result —
-- never uses > max_uses.
create or replace function public.consume_promo_use(p_tenant uuid, p_promo uuid)
returns integer
language sql volatile security definer set search_path = public
as $$
  update public.promo_codes
     set uses = uses + 1
   where id = p_promo
     and tenant_id = p_tenant
     and p_tenant in (select public.auth_tenant_ids())
     and is_active
     and now() >= valid_from
     and now() <= valid_until
     and (max_uses is null or uses < max_uses)
  returning uses;
$$;

grant execute on function public.consume_promo_use(uuid, uuid) to arena_app;
