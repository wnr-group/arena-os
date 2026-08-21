-- ============================================================================
-- Arena OS — 0028: `wallet_topup` as an invoice line kind
--
-- Selling wallet credit is not the same event as selling court time or food,
-- and it must not be reported as though it were.
--
-- ── Why a new kind rather than reusing 'adjustment' ─────────────────────────
-- A top-up is money RECEIVED IN ADVANCE, not revenue earned. The revenue is
-- recognised later, when the credit is spent on a booking or a meal. Filing
-- top-ups under 'adjustment' would mix them with genuine corrections and make
-- "what did we actually sell?" unanswerable without guesswork. A distinct kind
-- keeps the two separable in one WHERE clause, for the price of widening one
-- CHECK constraint.
--
-- ── Tax ─────────────────────────────────────────────────────────────────────
-- The line is raised at 0%. Under Indian GST, issuing a wallet/voucher balance
-- is not itself a supply — tax attaches when the credit is redeemed against a
-- real supply, which is when the booking or food line carries it. Charging GST
-- on the top-up as well would tax the same rupee twice.
--
-- The ledger itself is UNCHANGED: wallet_transactions (0007) already holds
-- signed amounts with a reason and a source reference, and remains the single
-- source of truth for the balance. No balance column is introduced anywhere.
-- ============================================================================

alter table public.invoice_items
  drop constraint if exists invoice_items_kind_check;

alter table public.invoice_items
  add constraint invoice_items_kind_check
  check (kind in ('booking','food','membership','adjustment','wallet_topup'));

-- Reporting: "which invoices were wallet top-ups?" and, with the ledger's
-- source_id, the join back from a credit to the bill that paid for it.
create index if not exists idx_invoice_items_wallet_topup
  on public.invoice_items(tenant_id, invoice_id)
  where kind = 'wallet_topup';

-- The ledger's source_type values in use, for reference (all free text, no
-- schema change needed):
--   'membership'      credit — granted when a membership is bought  (AROS-60)
--   'wallet_topup'    credit — bought at the till, source_id = invoice   (here)
--   'invoice_payment' debit  — spent on a bill,   source_id = payment    (here)
--   'wallet_refund'   credit — restored when a wallet payment is refunded (here)
