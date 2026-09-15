-- ============================================================================
-- Arena OS — 0088: seat/guest tagging on order_items (M18 #1)
--
-- Prerequisite for splitting a restaurant bill "by who ordered what" (M18
-- #2): a waiter tags "seat 1 had the pasta, seat 2 had the steak" as they
-- order, so the split-bill story can later group order_items by seat_no.
--
-- Additive, nullable — same discipline as 0021/0073's snapshot columns on
-- this table. Null means "no seat assigned" (a shared platter, an even-split
-- table, or any non-restaurant booking's food line) and stays fully valid;
-- tagging is optional and never blocks placing an order. seat_no is pure
-- bookkeeping for later splitting — it is never read by pricing
-- (lib/billing/pricing.ts's priceBill/loadFoodLines) and never changes a
-- line's total.
--
-- Small int, not a FK to anything: a "seat" is just an ordinal within the
-- booking's cover_count (0071), not a row of its own — there is no seats
-- table to reference, and a table's seat numbering never outlives the table
-- session it was entered for.
-- ============================================================================

alter table public.order_items
  add column if not exists seat_no smallint check (seat_no is null or seat_no > 0);

comment on column public.order_items.seat_no is
  'Optional 1-based seat/guest number within the booking''s cover_count (M18 #1) — set by the
   waiter at order time for later by-seat bill splitting. Null = unassigned/shared, valid for
   every line including every non-restaurant booking''s. Snapshot only; never affects pricing.';
