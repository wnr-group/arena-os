-- ============================================================================
-- Arena OS — 0031 order_items: happy-hour snapshot
--
-- A happy-hour rule can change or be deleted after an order is placed, but a
-- bill printed today must still read the same next month (same rule invoices
-- already follow — see 0014_billing.sql / invoice_items). So the discount an
-- order line received is frozen onto the row at order time, not re-derived
-- from `happy_hours` later. `happy_hour_id` is kept only as a soft pointer
-- (on delete set null) for reporting; nothing re-reads it to reprice.
-- ============================================================================

alter table public.order_items
  add column if not exists happy_hour_id             uuid references public.happy_hours(id) on delete set null,
  add column if not exists happy_hour_name            text,
  add column if not exists original_unit_price        numeric(10,2),
  add column if not exists happy_hour_discount_type    public.discount_type,
  add column if not exists happy_hour_discount_value   numeric(10,2);
