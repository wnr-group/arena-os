-- ============================================================================
-- Arena OS — 0147 events: never resurrect a cancelled entry that cannot stand.
--
-- Two guards on confirm_event_registration_payment(), both for a payment that
-- lands on a CANCELLED registration: another active entry by the same customer
-- (flipping to 'registered' violated idx_event_registrations_active and made
-- the webhook fail forever), and a withdrawn team. Both now keep the row
-- cancelled, record the money, flag refund_required and audit it, returning
-- 'unfulfillable'. Everything else is as in 0146, whose header follows.
--
-- ── 0146 ────────────────────────────────────────────────────────────────────
-- Arena OS — 0146 events: a payment landing on a closed event is owed back.
--
-- confirm_event_registration_payment() never read events.status. A customer
-- could open checkout, staff could cancel the event (cancelling its
-- registrations), and the Razorpay capture arriving afterwards flipped the row
-- back to `registered` with paid_amount set and refund_required = false: the
-- venue kept the money, nothing flagged it as owed, a "registered" entrant now
-- existed on a cancelled event, and lib/reports/events.ts counted it as revenue.
-- A late UPI capture on a completed event with a live hold did the same.
--
-- The function now checks the event's status first. For 'cancelled',
-- 'completed' and 'in_progress' the entry is cancelled, the money recorded and
-- refund_required set, an audit row is written like the other refund branches,
-- and 'event_closed' is returned (a REFUND_OUTCOMES member in the TS caller).
--
-- An entrant who already holds a place (registered / checked_in) is never
-- cancelled by a late payment; on a cancelled event the money is still flagged
-- as owed back.
--
-- 0139 has shipped on this chain, so this is a new migration rather than an
-- edit. Everything other than the new branch is unchanged from 0139.
-- ============================================================================

create or replace function public.confirm_event_registration_payment(
  p_registration_id   uuid,
  p_payment_reference text,
  p_amount            numeric
)
returns text
language plpgsql
as $$
declare
  v_reg   public.event_registrations%rowtype;
  v_event public.events%rowtype;
  v_occ   integer;
begin
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;
  if not found then return 'not_found'; end if;

  select * into v_event from public.events e where e.id = v_reg.event_id for update;
  if not found then return 'not_found'; end if;

  -- Re-read under the lock.
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;

  -- Idempotency, independent of the webhook's own: the same Razorpay payment
  -- arriving twice finds its own reference already stored and changes nothing.
  if v_reg.payment_reference is not null then
    if v_reg.payment_reference = p_payment_reference then return 'duplicate'; end if;
    -- A DIFFERENT payment against an already-settled registration: the place is
    -- never granted twice, but the money is owed back (see 0139).
    update public.event_registrations
       set refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_already_paid',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status,
                               'refundRequired', v_reg.refund_required,
                               'paymentReference', v_reg.payment_reference),
            jsonb_build_object('status', v_reg.status, 'refundRequired', true,
                               'duplicatePaymentReference', p_payment_reference,
                               'duplicateAmount', p_amount));
    return 'already_paid';
  end if;

  -- The event is closed: cancelled, completed, or already under way. A place
  -- cannot be granted for it, so the money is recorded and flagged as owed back.
  -- Checked before the fee comparison, which is moot for a closed event.
  if v_event.status in ('cancelled', 'completed', 'in_progress') then
    if v_reg.status in ('registered', 'checked_in') then
      -- Never cancel someone who already holds a place because a payment
      -- arrived. Record the money; it is owed back only if the event is off.
      update public.event_registrations
         set paid_amount = p_amount,
             payment_reference = p_payment_reference,
             refund_required = (v_event.status = 'cancelled')
       where id = p_registration_id;

      if v_event.status = 'cancelled' then
        insert into public.audit_log
          (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
        values (v_reg.tenant_id, null, 'event_registration.payment_event_closed',
                'event_registration', p_registration_id,
                jsonb_build_object('status', v_reg.status, 'eventStatus', v_event.status),
                jsonb_build_object('status', v_reg.status, 'refundRequired', true,
                                   'paidAmount', p_amount, 'paymentReference', p_payment_reference));
        return 'event_closed';
      end if;
      return 'confirmed';
    end if;

    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = coalesce(cancelled_at, now()),
           payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_event_closed',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status, 'eventStatus', v_event.status),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'event_closed';
  end if;

  -- The money must equal the event's OWN fee (see 0127/0139).
  if p_amount <> v_event.entry_fee then
    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = now(),
           payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_amount_mismatch',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status, 'expected', v_event.entry_fee),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'amount_mismatch';
  end if;

  -- Already holds a place: record the money against it, change nothing else.
  if v_reg.status in ('registered', 'checked_in') then
    update public.event_registrations
       set paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = false
     where id = p_registration_id;
    return 'confirmed';
  end if;

  -- A CANCELLED row is about to be resurrected (the hold lapsed or the entry was
  -- cancelled, and the payment landed anyway). That is only safe if it can
  -- still stand as an entry:
  --   * the customer has not registered again — the flip to 'registered'
  --     would violate idx_event_registrations_active and roll back the whole
  --     webhook transaction, so Razorpay would retry and fail forever with
  --     the money captured and nothing recorded;
  --   * its team has not been withdrawn — otherwise the entrant would hold a
  --     seat on a dead team.
  -- Either way the row stays cancelled and the money is flagged as owed back.
  if v_reg.status = 'cancelled' and (
       exists (
         select 1 from public.event_registrations o
          where o.tenant_id = v_reg.tenant_id
            and o.event_id = v_reg.event_id
            and o.customer_id = v_reg.customer_id
            and o.id <> p_registration_id
            and o.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
       )
       or (
         v_reg.team_id is not null
         and exists (
           select 1 from public.event_teams t
            where t.id = v_reg.team_id and t.status = 'withdrawn'
         )
       )
     ) then
    update public.event_registrations
       set payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_unfulfillable',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'reason', 'superseded_or_team_withdrawn',
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'unfulfillable';
  end if;

  -- Is there a place for them? Counted EXCLUDING this registration.
  select count(*)::int into v_occ
    from public.event_registrations r
   where r.event_id = v_reg.event_id
     and r.id <> p_registration_id
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     );

  if v_event.capacity is not null and v_occ >= v_event.capacity then
    update public.event_registrations
       set status = 'cancelled',
           cancelled_at = now(),
           payment_hold_expires_at = null,
           paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = true
     where id = p_registration_id;

    insert into public.audit_log
      (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
    values (v_reg.tenant_id, null, 'event_registration.payment_unfulfillable',
            'event_registration', p_registration_id,
            jsonb_build_object('status', v_reg.status),
            jsonb_build_object('status', 'cancelled', 'refundRequired', true,
                               'paidAmount', p_amount, 'paymentReference', p_payment_reference));
    return 'unfulfillable';
  end if;

  update public.event_registrations
     set status = 'registered',
         registered_at = now(),
         payment_hold_expires_at = null,
         paid_amount = p_amount,
         payment_reference = p_payment_reference,
         refund_required = false
   where id = p_registration_id;

  return 'confirmed';
end;
$$;
