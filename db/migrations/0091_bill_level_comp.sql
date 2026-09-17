-- ============================================================================
-- Arena OS — 0091: bill-level comp/discount (M18 #5)
--
-- Beyond M17's single-item void/comp (0073/0074), a manager sometimes writes
-- off or discounts the WHOLE bill — a service recovery, a VIP, a staff meal.
-- Like an item comp this moves money, so it is manager-authorised (checked in
-- lib/actions/billing.ts, the same requireManager()-style gate refunds.ts
-- already uses — see AuditActor there) and every use is written to
-- audit_log with actor, amount and reason, following the exact shape M17's
-- applyVoidDecision already writes (action/entityType/entityId/before/after).
--
-- `comp_amount` is one component of `discount` above (like membership_discount
-- and loyalty_discount already are), never an extra amount alongside it —
-- issueInvoiceForBooking/issueSplitBillForBooking cap the combined total at
-- the subtotal exactly as those two already do, so a comp can never drive a
-- bill negative. `comp_reason` is required whenever comp_amount > 0 — enforced
-- in lib/billing/invoice.ts, same discipline as order_items.void_reason
-- (0073): no DB CHECK, since a cashier's ordinary bill (comp_amount = 0) must
-- never need one.
--
-- Restaurant tenants only (M18's own scope) — enforced server-side in
-- lib/actions/billing.ts, not by a DB constraint, since `invoices` is shared
-- by every industry and comp_amount simply stays 0 for all of them.
-- ============================================================================

alter table public.invoices
  add column if not exists comp_amount             numeric(10,2) not null default 0,
  add column if not exists comp_reason             text,
  add column if not exists comped_by_membership_id uuid references public.memberships(id) on delete set null;

alter table public.invoices
  drop constraint if exists invoices_comp_amount_check;
alter table public.invoices
  add constraint invoices_comp_amount_check check (comp_amount >= 0);

comment on column public.invoices.comp_amount is
  'Manager-authorised bill-level comp/discount (M18 #5) — one component of `discount` above, never an
   extra amount alongside it. Restaurant tenants only; 0 for every other industry and for an ordinary
   bill with no comp. Every non-zero use is also written to audit_log (action=''invoice.comp'').';
comment on column public.invoices.comp_reason is
  'Manager-entered reason for the comp — required by lib/billing/invoice.ts whenever comp_amount > 0,
   never set otherwise. The durable copy also lives in the matching audit_log row.';
comment on column public.invoices.comped_by_membership_id is
  'The manager/owner who authorised the comp. Soft pointer, ON DELETE SET NULL — audit_log is the
   durable record of who, same discipline as order_items.voided_by (0073).';
