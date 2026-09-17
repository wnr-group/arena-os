-- ============================================================================
-- Arena OS — 0090: service charge + tip (M18 #3)
--
-- Service charge is a TENANT-CONFIGURED % of the bill (0 = off, the column
-- default), optionally taxed at its own configured GST rate — tied to the
-- tenant's own `tax_rates` (not a free-typed number) so the rate used can
-- never drift from a slab the tenant actually files under. Resolved via
-- lib/settings/business-profile.ts's loadServiceChargeConfig, computed via
-- lib/billing/pricing.ts's computeServiceCharge, folded into the SAME
-- invoice total/tax_total/tax_breakup columns every other bill already uses
-- (see lib/billing/invoice.ts) — `service_charge_percent`/`_amount`/
-- `_tax_percent` are the reconstructable snapshot, same discipline as the
-- existing `membership_discount`/`membership_discount_percent` pair.
--
-- Tip is captured PER PAYMENT (a tip travels with one tender, not the whole
-- bill) and is DELIBERATELY separate from `payments.amount`:
-- recordPaymentForInvoice's `alreadyPaid + amount <= total` balance check is
-- completely untouched — a tip added to `amount` would make an ordinary
-- bill+tip payment look like an overpayment and get refused. `invoices.tip_
-- amount` is a running aggregate, incremented in the SAME transaction as
-- each tip-bearing payment (never independently computed), so it can never
-- drift from the sum of its payments' own tip_amount. `tip_recipient_
-- membership_id` is nullable — an unattributed/pooled tip is still valid
-- and still traceable to the table via payments.invoice_id → booking, for
-- M20 payroll later.
-- ============================================================================

alter table public.business_profiles
  add column if not exists service_charge_percent numeric(5,2) not null default 0,
  add column if not exists service_charge_tax_rate_id uuid references public.tax_rates(id) on delete set null;

alter table public.business_profiles
  drop constraint if exists business_profiles_service_charge_percent_check;
alter table public.business_profiles
  add constraint business_profiles_service_charge_percent_check
    check (service_charge_percent >= 0 and service_charge_percent <= 100);

comment on column public.business_profiles.service_charge_percent is
  'Restaurant service charge %, applied to the pre-discount subtotal on every bill (M18 #3). 0 = off.';
comment on column public.business_profiles.service_charge_tax_rate_id is
  'Which of the tenant''s own tax_rates GST applies to the service charge itself. Null = the service
   charge is not taxed — a deliberate, non-default configuration, not an oversight.';

alter table public.invoices
  add column if not exists service_charge_percent numeric(5,2) not null default 0,
  add column if not exists service_charge_amount numeric(10,2) not null default 0,
  add column if not exists service_charge_tax_percent numeric(5,2) not null default 0,
  add column if not exists tip_amount numeric(10,2) not null default 0;

alter table public.invoices
  drop constraint if exists invoices_service_charge_percent_check;
alter table public.invoices
  add constraint invoices_service_charge_percent_check
    check (service_charge_percent >= 0 and service_charge_percent <= 100);
alter table public.invoices
  drop constraint if exists invoices_service_charge_amount_check;
alter table public.invoices
  add constraint invoices_service_charge_amount_check check (service_charge_amount >= 0);
alter table public.invoices
  drop constraint if exists invoices_service_charge_tax_percent_check;
alter table public.invoices
  add constraint invoices_service_charge_tax_percent_check check (service_charge_tax_percent >= 0);
alter table public.invoices
  drop constraint if exists invoices_tip_amount_check;
alter table public.invoices
  add constraint invoices_tip_amount_check check (tip_amount >= 0);

comment on column public.invoices.service_charge_percent is
  'Snapshot of business_profiles.service_charge_percent as it was when this bill was raised — frozen,
   never re-read from live settings (same discipline as membership_discount_percent).';
comment on column public.invoices.service_charge_amount is
  'subtotal (pre-discount) x service_charge_percent, already folded into total/tax_total below.';
comment on column public.invoices.service_charge_tax_percent is
  'The GST rate applied to service_charge_amount, if any (0 = untaxed). Its tax amount is
   reconstructable as round(service_charge_amount x service_charge_tax_percent / 100), and is
   already folded into tax_total/tax_breakup — never a separate figure to add on top.';
comment on column public.invoices.tip_amount is
  'Running aggregate of tip_amount across every captured payment on this invoice (or, for a split
   bill, this one check) — incremented transactionally alongside each payment insert, never
   independently computed. NOT part of total/balance: a tip is extra money on top of the bill,
   never counted toward what settles it.';

alter table public.payments
  add column if not exists tip_amount numeric(10,2) not null default 0,
  add column if not exists tip_recipient_membership_id uuid references public.memberships(id) on delete set null;

alter table public.payments
  drop constraint if exists payments_tip_amount_check;
alter table public.payments
  add constraint payments_tip_amount_check check (tip_amount >= 0);

comment on column public.payments.tip_amount is
  'Tip collected alongside this ONE tender (M18 #3) — never added to `amount`, never counted toward
   the invoice balance. Feeds tips payout reporting later (M20).';
comment on column public.payments.tip_recipient_membership_id is
  'Which staff member the tip is for, if the cashier attributed it at payment time. Null = pooled/
   unattributed — still traceable to the table via invoice_id -> booking.';

-- Service charge is its own invoice-line kind, alongside the existing
-- booking/food/membership/adjustment/wallet_topup (see 0038's own header for
-- why a distinct kind beats folding into 'adjustment': reporting needs to
-- separate "what did we sell" from "what did we add on top" in one WHERE).
alter table public.invoice_items
  drop constraint if exists invoice_items_kind_check;
alter table public.invoice_items
  add constraint invoice_items_kind_check
  check (kind in ('booking','food','membership','adjustment','wallet_topup','service_charge'));
