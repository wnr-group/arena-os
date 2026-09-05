-- ============================================================================
-- Arena OS — 0073: void/comp a single order_items line (M17 #6)
--
-- Before this, order_items had no lifecycle at all — every line on an `open`
-- order was billed, unconditionally (see lib/billing/invoice.ts loadFoodLines
-- / loadOrderFoodLines). A mis-fired item or a manager's comp had no way to
-- come off the tab short of deleting the row outright, which would also erase
-- it from the kitchen ticket and leave no trail for the void/comp report
-- (M20). So: an additive, nullable-except-status set of columns, the same
-- pattern as 0021_order_item_happy_hour.sql.
--
-- `void_status` distinguishes a VOID (removed, ordered by mistake — the venue
-- never intended to give the food away) from a COMP (given free — a
-- deliberate, still-worth-reporting write-off). Both are excluded from
-- billing identically; only the status tells them apart on the report.
--
-- The row is never deleted: the kitchen ticket, the order history and the
-- audit_log entry (written by lib/orders/service.ts's voidOrderItemCore) all
-- reference it, and M20 needs the line itself to report on.
-- ============================================================================

do $$ begin
  create type public.order_item_void_status as enum ('active', 'voided', 'comped');
exception
  when duplicate_object then null;
end $$;

alter table public.order_items
  add column if not exists void_status public.order_item_void_status not null default 'active',
  add column if not exists void_reason  text,
  add column if not exists voided_by    uuid references public.memberships(id) on delete set null,
  add column if not exists voided_at    timestamptz;

comment on column public.order_items.void_status is
  'active = billable as normal. voided = removed, ordered by mistake. comped = given free. Both voided/comped are excluded from billing (M17 #6).';
comment on column public.order_items.void_reason is
  'Manager-entered reason for a void/comp — required by lib/orders/service.ts, never set for an active line.';
comment on column public.order_items.voided_by is
  'The manager (or manager-overridden cashier) who authorised the void/comp. Soft pointer, ON DELETE SET NULL — the audit_log row is the durable record of who.';
comment on column public.order_items.voided_at is
  'When the void/comp happened. Null for an active line.';
