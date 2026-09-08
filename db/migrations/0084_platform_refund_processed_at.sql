-- ============================================================================
-- Arena OS — 0084 when a platform refund actually processed
--
-- A correctness fix to the AROS-114 revenue chart, not a new feature. One
-- nullable timestamp.
--
-- ── THE DISCREPANCY THIS CLOSES ─────────────────────────────────────────────
--
-- lib/platform/billing/metrics.ts documents its refund series as the CASH view:
--
--     "Refunds are bucketed by when they PROCESSED, not by the date of the
--      invoice they reverse. A refund issued in March against a January charge
--      is March's cash movement; restating January would change a month an
--      operator has already read and reported on."
--
-- The intent is right and the first half of it held — refunds were never
-- bucketed by the invoice they reverse. But the column the query actually
-- reached for was `created_at`, which is when the refund was RESERVED, and
-- 0082's whole design is that reserving and processing are deliberately not the
-- same moment:
--
--     phase 1  reserve   INSERT status='pending'          ← created_at
--     phase 2  instruct  call Razorpay
--     phase 3  settle    status='processed'               ← the money moves
--
-- Usually those are seconds apart and the bucket is the same. The gap opens
-- exactly where 0082 says it will: on a timeout or a 5xx the row is left
-- 'pending' ON PURPOSE — releasing a reservation against money that may already
-- be gone is the one mistake that cannot be undone — and a signature-verified
-- `refund.processed` webhook settles it later. Later can be the next day, and
-- across a month boundary it is the next reporting period.
--
-- The visible effect was the precise thing the comment set out to avoid. Since
-- only `status = 'processed'` rows are counted at all, a refund reserved on
-- 31 March and settled on 2 April was absent when an operator read March on
-- 1 April, then appeared inside March when they read it again on 3 April. The
-- month restated itself after it had been reported.
--
-- ── WHY A COLUMN, AND NOT `updated_at` ──────────────────────────────────────
--
-- `updated_at` is maintained by trg_platform_refunds_updated (0082) on EVERY
-- update, so it is "when this row last changed", not "when the money left". It
-- already moves for reasons that have nothing to do with settlement — a 4xx
-- refusal rewriting `reason` and status to 'failed', for instance — and any
-- future column added to this table would move it again, silently restating a
-- historical revenue figure. A fact that a financial series is read from should
-- be stored once, when it happens, and never touched afterwards.
--
-- ── NULLABLE, AND THAT IS THE BACKWARD-COMPATIBLE READ ──────────────────────
--
-- Null means "not settled" for a pending row, and for a 'failed' one it stays
-- null forever, which is correct: nothing processed. Readers therefore bucket
-- on `coalesce(processed_at, created_at)` — the new fact where it exists, the
-- old behaviour where it does not — so the series is well-defined for rows that
-- predate this migration and for any that arrive without it.
-- ============================================================================

alter table public.platform_refunds
  add column if not exists processed_at timestamptz;

comment on column public.platform_refunds.processed_at is
  'When the gateway confirmed the money left — set once, at the moment status becomes ''processed'', by lib/platform/billing/refunds.ts (the phase-3 settle) or by a signature-verified refund.processed webhook. Null while pending and forever for a failed refund. This is the timestamp the AROS-114 revenue series buckets refunds on, deliberately NOT updated_at, which moves on every write.';

-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- For rows already 'processed', `updated_at` is the best evidence available of
-- when they settled and is very close to right: the settle is the last write
-- such a row receives on the normal path, since applyVerifiedRefundEvent()
-- refuses to move a refund out of a final state, so nothing updates it again.
--
-- Scoped to 'processed' only. A pending row has not settled and must stay null,
-- and a failed one never will — backfilling either would invent a cash movement
-- that did not happen, which is worse than the imprecision this repairs.
update public.platform_refunds
   set processed_at = updated_at
 where status = 'processed'
   and processed_at is null;

-- ── INDEX ───────────────────────────────────────────────────────────────────
--
-- The revenue chart scans processed refunds within a date window, which is the
-- one predicate this column is ever used for. Partial, because the rows that
-- matter are exactly the settled ones and a pending or failed refund should not
-- occupy space in an index built to answer "what cash went back, and when".
create index if not exists idx_platform_refunds_processed
  on public.platform_refunds (processed_at)
  where status = 'processed';

-- No grant change. `arena_app` holds SELECT on platform_refunds and nothing
-- else (0082); this column inherits exactly that, so a business can no more
-- stamp its own refund as settled than it can mark it processed.
