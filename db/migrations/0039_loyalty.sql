-- ============================================================================
-- Arena OS — 0029 loyalty: the earn/redeem rule, idempotency, and the snapshot
--
-- The LEDGER is unchanged. `loyalty_transactions` (0007) is append-only with a
-- signed integer `points` — positive earned, negative redeemed — and the
-- balance is `sum(points)` via loyaltyPoints(). No points column is added to
-- customers or anywhere else, and no second ledger is created.
--
-- Three things are added:
--   1. loyalty_settings — the per-tenant earn/redeem rule. None existed.
--   2. a uniqueness rule on the ledger, so one invoice can earn or redeem once.
--   3. snapshot columns on invoices, so an old bill explains itself.
-- ============================================================================

-- ── 1. the rule ──────────────────────────────────────────────────────────────
-- Shaped exactly like payment_settings (0022): tenant_id IS the primary key,
-- one row per tenant, no surrogate id. That is the established home for
-- per-tenant module configuration in this codebase, and nothing existing was
-- suitable — business_profiles is the owner-only LEGAL identity for GST
-- invoices, not a place for a rewards rule.
--
-- Defaults encode the ticket's worked example, "1 point per ₹100" and
-- "1 point = ₹1", so a tenant that never opens the settings page still behaves
-- the way the ticket describes.
create table if not exists public.loyalty_settings (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,

  -- EARN: `points_per_unit` points for every whole `unit_amount` of eligible
  -- spend. 1 per ₹100 by default. Integer points only — the ledger column is
  -- `integer`, so a fractional point cannot be represented and must not be
  -- invented.
  points_per_unit   integer not null default 1 check (points_per_unit > 0),
  unit_amount       numeric(10,2) not null default 100.00 check (unit_amount > 0),

  -- REDEEM: what one point is worth in rupees. ₹1 by default.
  point_value       numeric(10,2) not null default 1.00 check (point_value > 0),
  -- A floor, so a venue can refuse trivial redemptions. 0 = no floor.
  min_redeem_points integer not null default 0 check (min_redeem_points >= 0),

  -- Off by default is WRONG for this ticket's intent (the example assumes
  -- points accrue), so the programme is on unless a tenant turns it off.
  is_active         boolean not null default true,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_loyalty_settings_updated on public.loyalty_settings;
create trigger trg_loyalty_settings_updated before update on public.loyalty_settings
  for each row execute function public.set_updated_at();

alter table public.loyalty_settings enable row level security;

-- Read by the till (to price a redemption) and by the profile; written only by
-- owner/manager, because the rule is money. Same split as tax_rates (0013).
drop policy if exists loyalty_settings_select on public.loyalty_settings;
create policy loyalty_settings_select on public.loyalty_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists loyalty_settings_write on public.loyalty_settings;
create policy loyalty_settings_write on public.loyalty_settings
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update on public.loyalty_settings to arena_app;

-- ── 2. THE idempotency rule ──────────────────────────────────────────────────
-- One ledger entry per (tenant, purpose, source). An invoice earns once, is
-- redeemed against once, and each reversal happens once — enforced by Postgres,
-- so a double-clicked button, a retried action or a re-run finalisation loses
-- the race at the database rather than double-crediting.
--
-- Partial: hand-made adjustments carry no source_id and must stay repeatable.
--
-- `source_type` is what separates the purposes; the values in use are:
--   'invoice_earn'      credit — points earned when an invoice settles
--   'invoice_redeem'    debit  — points spent as a discount at billing
--   'earn_reversal'     debit  — earn taken back when the invoice is voided
--   'redeem_reversal'   credit — redemption returned when the invoice is voided
create unique index if not exists idx_loyalty_tx_source
  on public.loyalty_transactions(tenant_id, source_type, source_id)
  where source_id is not null;

-- The balance read, and the "has this invoice earned yet?" lookup.
create index if not exists idx_loyalty_tx_tenant_customer
  on public.loyalty_transactions(tenant_id, customer_id);

-- ── 3. the invoice snapshot ──────────────────────────────────────────────────
-- Same reasoning as the membership benefit columns in 0027: `invoices.discount`
-- is a single total that cannot explain itself. These freeze the loyalty half
-- at issue, INCLUDING the conversion rate used, so reprinting a two-year-old
-- bill never consults today's loyalty_settings.
alter table public.invoices
  add column if not exists loyalty_points_redeemed integer not null default 0,
  add column if not exists loyalty_discount numeric(10,2) not null default 0,
  -- ₹ per point at the moment of redemption. The rate can change afterwards;
  -- this is what was actually honoured.
  add column if not exists loyalty_point_value numeric(10,2) not null default 0,
  -- Filled when the invoice settles, so a receipt can say "earned 10 points".
  add column if not exists loyalty_points_earned integer not null default 0;

do $$ begin
  alter table public.invoices
    add constraint invoices_loyalty_nonneg
    check (loyalty_points_redeemed >= 0 and loyalty_discount >= 0
           and loyalty_point_value >= 0 and loyalty_points_earned >= 0);
exception when duplicate_object then null; end $$;

-- The loyalty discount is a COMPONENT of `discount`, never an extra amount
-- alongside it — the same containment 0027 applies to the membership half. With
-- both constraints in place, membership + loyalty can each be checked against
-- the total the bill actually took off.
do $$ begin
  alter table public.invoices
    add constraint invoices_loyalty_discount_within_total
    check (loyalty_discount <= discount);
exception when duplicate_object then null; end $$;
