-- ============================================================================
-- Arena OS — 0049 loyalty tiers (data + configuration)
--
-- The LEDGER is unchanged. loyalty_transactions (0014) stays append-only with a
-- signed integer `points`, and no tier column, cached tier or points total is
-- added anywhere. A tier is DERIVED from the ledger on read, the same way the
-- balance already is.
--
-- ── The points basis, stated once, here ─────────────────────────────────────
--
-- `threshold` is compared against LIFETIME POINTS EARNED, not the spendable
-- balance that loyaltyPoints() returns.
--
-- Those are two different numbers and conflating them would be a business bug:
-- loyaltyPoints() is sum(points) over EVERY row, so redeeming points lowers it.
-- If tiers keyed off that, a customer would be DEMOTED for using the rewards
-- they earned — Gold on Monday, Silver on Tuesday because they spent 200
-- points. A tier is a record of custom given, so it may only ever go up (and
-- down only when an earn is genuinely reversed).
--
-- 0039 already made this derivable without new storage: it defines four
-- purposes in `source_type`, of which exactly two move lifetime earned —
--
--     invoice_earn    credit, points earned when an invoice settles
--     earn_reversal   debit,  that earn taken back when the invoice is voided
--
-- while invoice_redeem / redeem_reversal move only the spendable balance. So
-- lifetime earned is sum(points) filtered to those two source types. See
-- lib/loyalty/tiers.ts (TIER_EARNING_SOURCE_TYPES) for the executable form.
-- ============================================================================

create table if not exists public.loyalty_tiers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  name        text not null check (length(btrim(name)) > 0),

  -- Lifetime points earned at or above which the customer holds this tier.
  -- Integer because the ledger's `points` column is integer — a fractional
  -- threshold could never be reached exactly and would only invite confusion.
  threshold   integer not null check (threshold >= 0),

  -- Display only. This ticket carries no benefit LOGIC: nothing in billing
  -- reads it, and tier-based discounts are explicitly out of scope. A free-text
  -- perk line is what the portal needs to say "Gold — 10% off food", without
  -- inventing a benefits engine that pricing would then have to honour.
  perk        text,

  sort_order  integer not null default 0,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One tier per threshold per tenant. This is what makes "the highest
  -- qualifying tier" a single unambiguous answer rather than a coin toss
  -- between two rows that qualify equally.
  constraint loyalty_tiers_tenant_threshold_key unique (tenant_id, threshold),
  -- Two tiers called "Gold" would be a configuration mistake, not a feature.
  constraint loyalty_tiers_tenant_name_key unique (tenant_id, name)
);

create index if not exists idx_loyalty_tiers_tenant
  on public.loyalty_tiers(tenant_id, threshold);

drop trigger if exists trg_loyalty_tiers_updated on public.loyalty_tiers;
create trigger trg_loyalty_tiers_updated before update on public.loyalty_tiers
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.loyalty_tiers enable row level security;

-- Read by any active member (the till shows a customer's tier), written only by
-- owner/manager. The same split tax_rates (0009) and loyalty_settings (0039)
-- use for a rule that decides what a customer is entitled to — a cashier may
-- see the ladder, not move it.
drop policy if exists loyalty_tiers_select on public.loyalty_tiers;
create policy loyalty_tiers_select on public.loyalty_tiers
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists loyalty_tiers_manager_write on public.loyalty_tiers;
create policy loyalty_tiers_manager_write on public.loyalty_tiers
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- The customer portal shows the ladder so a customer can see what they are
-- working toward. READ ONLY, and only their own tenant's — there is
-- deliberately no customer write policy of any kind, so the restrictive
-- isolation policies from 0045 are the only thing a customer context can do
-- here besides select.
drop policy if exists loyalty_tiers_customer_select on public.loyalty_tiers;
create policy loyalty_tiers_customer_select on public.loyalty_tiers
  for select using (tenant_id = public.current_customer_tenant_id());

-- Append/update/delete are all manager-gated by the policy above; the grant is
-- the standard business-table set.
grant select, insert, update, delete on public.loyalty_tiers to arena_app;

-- ── default tiers ───────────────────────────────────────────────────────────
-- Seeded for tenants that exist NOW, so a venue opening the settings page sees
-- an editable starting ladder rather than a blank screen.
--
-- Tenants created after this migration get no rows, and that is fine: the
-- computation falls back to the same three tiers in code (DEFAULT_TIERS in
-- lib/loyalty/tiers.ts), exactly as loadLoyaltyRule() falls back to
-- DEFAULT_LOYALTY_RULE when a tenant has never configured the programme. "No
-- row" and "default row" therefore behave identically, which is the convention
-- this codebase already uses for per-tenant configuration.
--
-- Idempotent by the unique (tenant_id, threshold) constraint plus DO NOTHING,
-- so re-running the migration — or running it against a database where an
-- operator has already tuned the ladder — adds nothing and overwrites nothing.
--
-- The values are the ticket's, and they are meaningful at this codebase's own
-- default earn rate (1 point per ₹100, 0039): 500 points is roughly ₹50,000 of
-- lifetime custom, 1000 is ₹100,000.
insert into public.loyalty_tiers (tenant_id, name, threshold, perk, sort_order)
select t.id, v.name, v.threshold, v.perk, v.sort_order
  from public.tenants t
 cross join (values
   ('Bronze',    0, 'Welcome to the programme.', 0),
   ('Silver',  500, 'Priority booking.',         1),
   ('Gold',   1000, 'Priority booking and member pricing.', 2)
 ) as v(name, threshold, perk, sort_order)
on conflict on constraint loyalty_tiers_tenant_threshold_key do nothing;
