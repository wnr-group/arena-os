-- ============================================================================
-- Arena OS — 0101: advance cash payment — data model
--
-- M26 #1 — the foundation the rest of the advance-payment series builds on
-- (gaming-cafe pre-collected cash: staff take money at the counter before
-- the booking even exists, then create the booking/walk-in). Needs its own
-- column: bookings.deposit is already live-wired to the online Razorpay
-- "Pay Deposit" button (lib/payments/deposits.ts) as money still OWED via
-- card/UPI — writing a cash-collected amount into that column would make
-- that button try to re-charge money already collected in cash.
--
-- advance_paid   — the amount staff recorded as collected in cash up front.
-- advance_applied — idempotency flag: flips true the moment a later ticket
-- folds this into a real payments row against an issued invoice, so
-- re-running/re-checking billing on the same booking can never apply the
-- same cash twice.
--
-- Existing rows read advance_paid=0, advance_applied=false — every existing
-- booking, every non-gaming-cafe tenant, is byte-identical to today. Nothing
-- reads these columns yet.
-- ============================================================================

alter table public.bookings
  add column if not exists advance_paid numeric(10,2) not null default 0 check (advance_paid >= 0),
  add column if not exists advance_applied boolean not null default false;

comment on column public.bookings.advance_paid is
  'M26 #1 — cash (or other offline tender) collected from the customer before this booking/walk-in was created, recorded by staff. Distinct from deposit, which is money still owed via the online Razorpay "Pay Deposit" flow (lib/payments/deposits.ts). 0 for every booking with nothing collected upfront.';
comment on column public.bookings.advance_applied is
  'M26 #1 — idempotency flag: set true the moment advance_paid is folded into a real payments row against an issued invoice, so the same cash can never be applied twice. False until then.';
