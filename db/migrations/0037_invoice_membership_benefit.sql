-- ============================================================================
-- Arena OS — 0027: the membership benefit actually applied to an invoice
--
-- AROS-61 lets an eligible customer's membership discount a bill automatically.
-- `invoices.discount` already holds the TOTAL taken off, but a single number
-- cannot explain itself: months later nobody can tell whether ₹250 was a promo,
-- a keyed-in discount, a membership benefit, or a mix.
--
-- These columns are the historical record of the membership half. They are a
-- SNAPSHOT, in the same spirit as customer_memberships' own benefit snapshot
-- (0026): once written they are never recomputed, so an invoice keeps saying
-- what it said even after the membership expires, the plan is repriced, the
-- plan is retired, or the customer buys a different plan.
--
-- Smallest change that satisfies "the receipt must explain the benefit without
-- querying the current plan": three columns and a reference. No second discount
-- system — `invoices.discount` remains the one authoritative total.
-- ============================================================================

alter table public.invoices
  add column if not exists customer_membership_id uuid,
  add column if not exists membership_discount numeric(10,2) not null default 0,
  add column if not exists membership_discount_percent numeric(5,2) not null default 0,
  -- Denormalised so the receipt can print "Gold member — 10% off" without
  -- joining customer_memberships (which may since have been cancelled) or
  -- membership_plans (which may since have been renamed).
  add column if not exists membership_plan_name text;

do $$ begin
  alter table public.invoices
    add constraint invoices_membership_discount_nonneg
    check (membership_discount >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.invoices
    add constraint invoices_membership_discount_percent_range
    check (membership_discount_percent >= 0 and membership_discount_percent <= 100);
exception when duplicate_object then null; end $$;

-- A membership discount cannot exceed the total discount actually taken off the
-- bill: the membership figure is one component of `discount`, never something
-- extra alongside it. This is the constraint that makes double-application
-- impossible to persist even if application code ever got it wrong.
do $$ begin
  alter table public.invoices
    add constraint invoices_membership_discount_within_total
    check (membership_discount <= discount);
exception when duplicate_object then null; end $$;

-- Composite FK — the device 0008/0010/0017/0023/0026 use — so an invoice can
-- never reference ANOTHER tenant's membership. Nulled rather than cascaded if
-- the membership row ever goes: the money figures above stay, because they are
-- the snapshot and the bill must remain explicable.
do $$ begin
  alter table public.invoices
    add constraint invoices_customer_membership_tenant_fkey
    foreign key (tenant_id, customer_membership_id)
    references public.customer_memberships(tenant_id, id)
    on delete set null (customer_membership_id);
exception when duplicate_object then null; end $$;

-- "Which invoices did this membership discount?" — the reporting question, and
-- the check that a benefit was applied once.
create index if not exists idx_invoices_customer_membership
  on public.invoices(tenant_id, customer_membership_id)
  where customer_membership_id is not null;
