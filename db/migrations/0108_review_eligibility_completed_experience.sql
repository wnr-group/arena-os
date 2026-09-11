-- ============================================================================
-- Arena OS — 0108 the Google review prompt asks only after something FINISHED.
--
-- Tightens what each half of customer_review_eligible() (0105, re-indexed 0107)
-- means, while keeping the two halves as OR. Same function, same callers, same
-- RLS — only the question it answers has changed.
--
-- ══ WHAT IT USED TO ASK ═════════════════════════════════════════════════════
--
--   a booking in (confirmed, checked_in, completed)   OR   an ACCEPTED order
--
-- The FOOD half was too loose. `accepted` only means somebody — a human or a
-- payment — let the order exist; the food may still have been sitting in the
-- kitchen, or never have been made at all. Asking a customer to review a meal
-- they had not been served is the case this closes.
--
-- ══ WHAT IT ASKS NOW ════════════════════════════════════════════════════════
--
--   a booking in (confirmed, checked_in, completed)   OR   a DELIVERED order
--
-- The BOOKING half is unchanged from 0105 and deliberately so — see below.
-- Only the food half moved.
--
-- ══ WHERE "DELIVERED" ACTUALLY LIVES — THIS IS THE PART TO READ ═════════════
--
-- `orders.status` is NOT a fulfilment column. Its enum is (open, billed,
-- cancelled) — that is the BILLING lifecycle, and `billed` means the tab was
-- closed, not that anybody was handed food. There is no 'delivered' or
-- 'completed' value on an order, so matching on one would have been inventing
-- a status the schema does not have.
--
-- Delivery is tracked on the KITCHEN TICKET. `kot_status` is
-- (pending, preparing, ready, served, cancelled), and `served` is the moment
-- food reached the customer. lib/orders/public-status.ts already treats it as
-- exactly that: deriveCustomerOrderStatus() maps the furthest non-cancelled KOT
-- to the status the customer is shown, and 'served' is its terminal state.
-- This mirrors that definition rather than adding a second one.
--
-- Every order has a KOT: createOrderCore() writes one in the SAME transaction
-- as the order (lib/orders/service.ts), one per order, so there is no order
-- that could be served yet have no ticket to prove it.
--
-- ══ THE THREE GATES ON THE FOOD SIDE ═══════════════════════════════════════
--
--   acceptance_status = 'accepted'   a human or a payment let the order exist.
--                                    Excludes pending, rejected and
--                                    awaiting_payment — an abandoned cart never
--                                    reaches accepted at all.
--   status <> 'cancelled'            a cancelled tab is not a meal, even if a
--                                    ticket was served before it was voided.
--   kots.status = 'served'           the food actually arrived.
--
-- ══ THE BOOKING SIDE IS UNCHANGED FROM 0105 ════════════════════════════════
--
--   status in (confirmed, checked_in, completed)
--
-- Not narrowed to `completed`. A booking that exists and has not been called
-- off is a real relationship with the venue, and the prompt is a courtesy ask
-- rather than a receipt — the customer can always answer "maybe later", and is
-- asked again next visit until they say they have reviewed.
--
-- `cancelled` and `no_show` stay out: somebody who called off or never turned
-- up has no experience to rate. That is the same line 0105 drew, kept.
--
-- `completed` is included even though ACTIVE_BOOKING_STATUSES omits it — that
-- constant answers "is this booking live right now", a different question from
-- "did this customer have a session".
--
-- ══ WHY OR AND NOT AND ══════════════════════════════════════════════════════
--
-- A venue does not have to sell food. A recording studio, a VR centre and a
-- dance studio have no kitchen and therefore no KOT will ever exist for them —
-- requiring both halves would mean their customers could never be asked at all.
-- Equally, someone who only ordered food and never booked a resource still had
-- an experience worth rating, and a venue with no bookable resources at all
-- would be shut out the other way.
--
-- So either finished experience is enough, and the DERIVED nature of this is
-- what keeps it honest: five completed bookings and five served orders still
-- produce one answer, because there is no per-booking row to produce five of.
--
-- ══ ISOLATION AND COST ══════════════════════════════════════════════════════
--
-- Both halves are pinned to current_customer_tenant_id() AND
-- current_customer_id(), read from the caller's own session GUCs and never from
-- an argument. So one tenant's completed booking cannot make another tenant's
-- customer eligible, and one customer's history cannot be borrowed by another.
--
-- The tenant pin is also what lets the (tenant_id, customer_id) indexes do a
-- two-column lookup instead of walking the whole index — the 0107 fix, kept.
-- The KOT side gets its own index below.
--
-- OR also short-circuits: a customer with a completed booking never costs the
-- food query at all, because Postgres stops at the first true EXISTS.
-- ============================================================================

-- ── the index the new EXISTS needs ──────────────────────────────────────────
--
-- `kots` had no index on order_id at all. Its only non-unique index is
-- idx_kots_open (tenant_id, branch_id, status), which is for the kitchen
-- screen and cannot serve "is there a served ticket for THIS order".
-- Postgres would have had to scan, once per candidate order, on every portal
-- page load by an un-answered customer — exactly the platform-wide scan 0107
-- removed from the booking side.
--
-- (tenant_id, order_id, status) in that order: tenant_id first to match how
-- every other index in this schema leads and to keep the lookup tenant-local,
-- order_id as the actual join key, status last so the EXISTS is answered from
-- the index without touching the heap.
create index if not exists idx_kots_order_status
  on public.kots(tenant_id, order_id, status);

comment on index public.idx_kots_order_status is
  'Answers "has a ticket for this order been served" for customer_review_eligible() (0108). Distinct from idx_kots_open, which serves the kitchen screen and leads with branch_id.';

-- ── the eligibility question itself ─────────────────────────────────────────
create or replace function public.customer_review_eligible()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_customer_id() is not null
     and public.current_customer_tenant_id() is not null
     and (
       -- a booking that is live or finished, never one called off …
       exists (
         select 1
           from public.bookings b
          where b.tenant_id = public.current_customer_tenant_id()
            and b.customer_id = public.current_customer_id()
            and b.status in ('confirmed', 'checked_in', 'completed')
       )
       -- … OR food that actually reached them.
       or exists (
         select 1
           from public.orders o
           join public.kots k
             on k.tenant_id = o.tenant_id
            and k.order_id = o.id
          where o.tenant_id = public.current_customer_tenant_id()
            and o.customer_id = public.current_customer_id()
            and o.acceptance_status = 'accepted'
            and o.status <> 'cancelled'
            and k.status = 'served'
       )
     );
$$;

revoke all on function public.customer_review_eligible() from public;
grant execute on function public.customer_review_eligible() to arena_app;

comment on function public.customer_review_eligible() is
  'Whether the current customer has EITHER a live-or-finished booking OR a DELIVERED food order, and is therefore due the Google review prompt (0105, re-indexed 0107, food half tightened in 0108). Either is enough — a venue with no kitchen, or none with bookable resources, would otherwise never qualify anyone. The booking half is unchanged from 0105: confirmed, checked_in or completed, never cancelled or no_show. The FOOD half now requires an accepted, non-cancelled order whose kitchen ticket is ''served'', because orders.status is the billing lifecycle (open/billed/cancelled) and carries no fulfilment state at all — an ''accepted'' order alone never meant the food arrived. Both halves are pinned to the caller''s own tenant and customer GUCs, never an argument. SECURITY DEFINER because a customer session has no policy on `orders` or `kots`. Returns one boolean.';
