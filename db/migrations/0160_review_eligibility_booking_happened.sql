-- ============================================================================
-- Arena OS — 0148 the Google review prompt asks only after a booking HAPPENED.
--
-- 0144 tightened the food half of customer_review_eligible() to "served" but
-- left the booking half at (confirmed, checked_in, completed). 'confirmed' is
-- true from the instant a booking is created, so a customer with a booking next
-- week was asked "Enjoyed your experience?" on their next portal visit, before
-- attending.
--
-- The booking half now requires:
--
--   status = 'completed'
--   OR status = 'checked_in' AND the booking's last slot has ended
--
-- 'confirmed' and 'pending_payment' (not yet attended), 'cancelled' and
-- 'no_show' (never attended) are all excluded. The food half, the OR between
-- the halves, the tenant/customer pinning and every grant are unchanged from
-- 0144; this is the same function with one predicate replaced.
--
-- booking_slots is read by booking_id, which idx_booking_slots_booking serves.
-- ============================================================================

create or replace function public.customer_review_eligible()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_customer_id() is not null
     and public.current_customer_tenant_id() is not null
     and (
       -- a booking whose session has HAPPENED …
       exists (
         select 1
           from public.bookings b
          where b.tenant_id = public.current_customer_tenant_id()
            and b.customer_id = public.current_customer_id()
            and (
              b.status = 'completed'
              -- Checked in, and every slot has ended. A checked-in customer
              -- who is still mid-session has nothing to review yet. A booking
              -- with no slots has no end to compare, so it never qualifies
              -- this way (max() is null).
              or (
                b.status = 'checked_in'
                and (
                  select max(s.ends_at)
                    from public.booking_slots s
                   where s.booking_id = b.id
                     and s.tenant_id = b.tenant_id
                ) <= now()
              )
            )
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
  'Whether the current customer has EITHER a booking that has happened OR a DELIVERED food order, and is therefore due the Google review prompt (0141, re-indexed 0143, food half tightened in 0144, booking half in 0148). A booking counts when it is ''completed'', or ''checked_in'' with every slot already ended; ''confirmed'' (which is true from the instant of booking, so includes future visits), ''pending_payment'', ''cancelled'' and ''no_show'' never do. The FOOD half requires an accepted, non-cancelled order whose kitchen ticket is ''served''. Both halves are pinned to the caller''s own tenant and customer GUCs, never an argument. SECURITY DEFINER because a customer session has no policy on bookings, orders or kots. Returns one boolean.';
