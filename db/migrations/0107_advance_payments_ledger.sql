-- ============================================================================
-- Arena OS — 0107: advance_payments ledger (M30 #1)
--
-- Replaces the single bookings.advance_paid number with an append-only ledger:
-- one row per TENDER, each with its own method (cash/card/upi), so one advance
-- can be split across modes. Same derive-don't-cache convention as the
-- wallet/loyalty ledgers (lib/customers/ledger.ts): later tickets sum this
-- table live; no cached total is kept anywhere.
--
-- Shape mirrors payments (0010) but keyed to booking_id — no invoice exists
-- yet when an advance is collected. bookings_tenant_id_key (0010) is the
-- composite FK target, exactly like payments_invoice_tenant_fkey.
--
-- This migration TOUCHES LIVE MONEY: every bookings row with advance_paid > 0
-- is backfilled into the ledger in this same transaction (no window where old
-- and new disagree), then count and sum parity are asserted — a mismatch
-- RAISES, which rolls the whole migration back.
--
-- bookings.advance_paid / advance_applied are NOT dropped (additive-only
-- migration discipline). They are superseded by this table and unread once
-- M30 #2–#4 land.
-- ============================================================================

create table if not exists public.advance_payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  branch_id    uuid not null references public.branches(id) on delete restrict,
  booking_id   uuid not null,
  method       text not null check (method in ('cash','card','upi')),
  amount       numeric(10,2) not null check (amount >= 0),
  collected_by uuid references public.memberships(id) on delete set null,
  -- Set once this tender is folded into a real invoice's payments row
  -- (lib/payments/advance-settlement.ts); null = still unconsumed. Per row,
  -- not a booking-level flag, so tenders can be consumed individually.
  invoice_id   uuid,
  created_at   timestamptz not null default now(),
  constraint advance_payments_booking_fk foreign key (tenant_id, booking_id)
    references public.bookings(tenant_id, id) on delete cascade
);

create index if not exists idx_advance_payments_booking
  on public.advance_payments(tenant_id, booking_id);

comment on table public.advance_payments is
  'M30 #1 — append-only ledger of advance tenders collected before a booking/walk-in existed, one row per tender. A booking''s advance is always SUM(amount) over this table; never cached. invoice_id is set when the tender is folded into a payments row.';

-- RLS + grants — same template as payments (0010).
alter table public.advance_payments enable row level security;

drop policy if exists advance_payments_rw on public.advance_payments;
create policy advance_payments_rw on public.advance_payments
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.advance_payments to arena_app;

-- ── Backfill: one 'cash' row per booking with advance_paid > 0 ─────────────
-- 'cash' is the only mode the shipped M26 ever recorded. Where advance_applied
-- is true the tender was already folded into that booking's invoice, so carry
-- the invoice id (prefer a live invoice, fall back to the latest of any status
-- so an applied tender can never read as unconsumed and be applied twice).
-- collected_by stays null: the old data has no per-cashier attribution.
-- Idempotent: skips bookings that already have a ledger row.
insert into public.advance_payments (tenant_id, branch_id, booking_id, method, amount, invoice_id)
select b.tenant_id, b.branch_id, b.id, 'cash', b.advance_paid,
       case when b.advance_applied then (
         select i.id from public.invoices i
         where i.tenant_id = b.tenant_id and i.booking_id = b.id
         order by (i.status <> 'void') desc, i.issued_at desc nulls last, i.created_at desc
         limit 1
       ) else null end
from public.bookings b
where b.advance_paid > 0
  and not exists (
    select 1 from public.advance_payments ap
    where ap.tenant_id = b.tenant_id and ap.booking_id = b.id
  );

-- ── Parity assertion: zero silent data loss, or the migration aborts ───────
do $$
declare
  old_n   bigint;
  new_n   bigint;
  old_sum numeric;
  new_sum numeric;
begin
  select count(*), coalesce(sum(advance_paid), 0)
    into old_n, old_sum from public.bookings where advance_paid > 0;
  select count(*), coalesce(sum(amount), 0)
    into new_n, new_sum from public.advance_payments;

  if old_n <> new_n or old_sum <> new_sum then
    raise exception
      'advance_payments backfill parity FAILED: bookings(advance_paid>0) count=% sum=% vs advance_payments count=% sum=%',
      old_n, old_sum, new_n, new_sum;
  end if;

  raise notice 'advance_payments backfill OK: % rows, total %', new_n, new_sum;
end $$;

comment on column public.bookings.advance_paid is
  'SUPERSEDED by public.advance_payments (M30 #1, 0107) — read SUM(advance_payments.amount) instead. Retained, unread, per additive-only migration discipline. Original (M26 #1): cash collected before this booking existed.';
comment on column public.bookings.advance_applied is
  'SUPERSEDED by public.advance_payments.invoice_id (M30 #1, 0107) — per-tender consumed marker replaces this booking-level flag. Retained, unread.';
