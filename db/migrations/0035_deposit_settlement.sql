-- ============================================================================
-- Arena OS — 0025: one gateway payment settles one invoice line (AROS-51)
--
-- The balance invariant is already implemented, once, in M1:
--
--     invoice.total - sum(payments where status='captured') = balance due
--
-- getInvoiceSettlement() computes it, the POS panel renders it, and the receipt
-- derives its PAID badge from it. AROS-51 adds NO second calculation. What it
-- adds is the missing link that makes an ONLINE DEPOSIT show up in that sum.
--
-- ── The gap this closes ─────────────────────────────────────────────────────
-- A deposit is taken at booking time, before any invoice exists (AROS-49), and
-- confirmed by the webhook (AROS-50). When the bill is finally raised, the
-- deposit is money the venue already holds — but it lives on `payment_intents`,
-- which capturedTotal() does not read. The bill would print the full total.
--
-- The fix is to carry a paid deposit onto the invoice as a `payments` row the
-- moment the invoice is created, so the EXISTING sum is simply correct. Two
-- code paths can do that carry-over — the webhook (deposit paid after the bill
-- was raised) and invoice creation (the usual order) — so the database needs to
-- guarantee they cannot both succeed for the same money.
--
-- ── This index is that guarantee ────────────────────────────────────────────
-- A Razorpay payment id is globally unique, so one may appear on at most one
-- payments row, ever. Partial because in-store tenders (cash/card/UPI) have no
-- gateway id and there are many of them. Mirrors
-- idx_payment_intents_gateway_payment from 0024: the same rule, one layer down.
--
-- Without it, a deposit confirmed at the same moment a cashier raises the bill
-- could be counted twice and the customer would appear to owe ₹200 less than
-- they do.
-- ============================================================================

create unique index if not exists idx_payments_gateway_payment
  on public.payments(gateway, gateway_payment_id)
  where gateway_payment_id is not null;

-- Reading a booking's deposits at invoice time. The composite (tenant_id,
-- booking_id) index on payment_intents from 0023 covers the lookup; this one
-- makes the "has this gateway payment already been carried over?" check on
-- payments cheap without relying on a scan of the unique index above.
create index if not exists idx_payments_tenant_gateway_payment
  on public.payments(tenant_id, gateway_payment_id)
  where gateway_payment_id is not null;
