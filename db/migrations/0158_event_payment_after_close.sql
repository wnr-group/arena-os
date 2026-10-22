-- ============================================================================
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
