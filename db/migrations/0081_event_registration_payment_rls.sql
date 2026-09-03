-- ============================================================================
-- Arena OS — 0081 the customer's payment-intent policies for event
-- registrations (M15 #3). Second half of 0080; see that file's header for why
-- these could not live in it.
--
-- ── The point of this file ──────────────────────────────────────────────────
--
-- "The server must derive the event fee from the event record" is the ticket's
-- rule, and the usual way to keep it is to write server code that reads
-- events.entry_fee and hope nothing later takes the amount from a form field
-- instead. The WITH CHECK below makes that impossible rather than merely
-- unlikely: under a customer context, Postgres will not accept an
-- event_registration payment intent whose `amount` differs from the event's own
-- `entry_fee`. A tampered price is a constraint violation, not a bad charge.
--
-- The same expression pins everything else that could be forged from a browser:
-- the purpose, the pending status, an empty gateway_payment_id, a null
-- created_by (a customer is not a staff membership), the tenant (derived inside
-- the database from the session's customer id), the branch (the event's own),
-- the registration being the CALLER'S OWN and actually awaiting payment with a
-- live hold, and the event still being open.
--
-- ── Why the customer gets a policy here but not on event_registrations ──────
--
-- Because this one IS a single-row question. "May this intent exist?" is
-- answerable from the row being written plus rows the caller may already read.
-- Capacity is not (see 0079's header), which is why registrations are written
-- through locked functions and intents are written through a policy.
-- ============================================================================

-- ── read: the customer's own pending order, so a retry reuses it ────────────
-- Scoped through the registration, which the customer_select policy on
-- event_registrations (0079) has already reduced to their own rows. A booking
-- deposit or an order pay-now intent is NOT reachable here — those carry a null
-- event_registration_id and fail the first predicate.
drop policy if exists payment_intents_customer_select on public.payment_intents;
create policy payment_intents_customer_select on public.payment_intents
  for select using (
    event_registration_id is not null
    and tenant_id = public.current_customer_tenant_id()
    and exists (
      select 1 from public.event_registrations r
       where r.id = payment_intents.event_registration_id
         and r.customer_id = public.current_customer_id()
    )
  );

-- ── write: open a gateway order for MY registration, at THE EVENT'S price ───
drop policy if exists payment_intents_customer_insert on public.payment_intents;
create policy payment_intents_customer_insert on public.payment_intents
  for insert with check (
    purpose = 'event_registration'
    and gateway = 'razorpay'
    and status = 'pending'
    -- Only the verified webhook may ever write this, and it does so on the
    -- owner connection. A customer-created intent starts unsettled.
    and gateway_payment_id is null
    -- A customer is not a staff membership.
    and created_by is null
    -- Exactly one target, and it is the registration one.
    and booking_id is null
    and order_id is null
    and event_registration_id is not null
    -- Tenant derived inside the database from the session's customer id, never
    -- taken from the caller.
    and tenant_id = public.current_customer_tenant_id()
    and exists (
      select 1
        from public.event_registrations r
        join public.events e
          on e.id = r.event_id and e.tenant_id = r.tenant_id
       where r.id = payment_intents.event_registration_id
         and r.tenant_id = payment_intents.tenant_id
         -- MINE.
         and r.customer_id = public.current_customer_id()
         -- …and genuinely awaiting payment, with the capacity hold still live.
         -- An expired hold means the place was released; paying for it would be
         -- paying for nothing.
         and r.status = 'pending_payment'
         and r.payment_hold_expires_at > now()
         -- THE anti-tampering rule.
         and payment_intents.amount = e.entry_fee
         and payment_intents.branch_id = e.branch_id
         and e.entry_fee > 0
         and e.status = 'registration_open'
    )
  );

-- Restrictive, so no future permissive policy can widen what a customer context
-- sees on a table that holds every tenant's gateway references. Trivially true
-- when no customer is signed in, so staff and webhook paths are untouched —
-- the same shape 0045 uses on bookings and wallet_transactions.
drop policy if exists payment_intents_customer_isolation on public.payment_intents;
create policy payment_intents_customer_isolation on public.payment_intents
  as restrictive for all
  using (
    public.current_customer_id() is null
    or (
      event_registration_id is not null
      and exists (
        select 1 from public.event_registrations r
         where r.id = payment_intents.event_registration_id
           and r.customer_id = public.current_customer_id()
      )
    )
  )
  with check (
    public.current_customer_id() is null
    or (
      event_registration_id is not null
      and exists (
        select 1 from public.event_registrations r
         where r.id = payment_intents.event_registration_id
           and r.customer_id = public.current_customer_id()
      )
    )
  );

-- Grants: nothing new. arena_app has held select/insert/update on
-- payment_intents since 0033; the policies above decide whether a customer
-- context may use them.
