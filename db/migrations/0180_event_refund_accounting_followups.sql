-- CodeRabbit follow-ups on 0177's refund accounting.
--
--  * cancel_event_registration: a registration that already owed a refund (a
--    duplicate capture) and is then cancelled now owes the old amount PLUS its
--    original payment, instead of keeping only the first.
--  * mark_event_registration_refunded: a partial refund leaves the balance
--    outstanding (flag stays up) rather than clearing everything.
--  * ...and its audit row records the manager who did it (auth_membership_id),
--    not null.
--
-- create or replace keeps the existing grants; they are restated to be explicit.

create or replace function public.cancel_event_registration(p_registration_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_reg      public.event_registrations%rowtype;
  v_is_staff boolean := false;
  v_is_owner boolean := false;
  v_was_held boolean;
  v_event_id uuid;
  v_lock     uuid;
  v_ev_status public.event_status;
  v_ev_starts timestamptz;
begin
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;
  if not found then return 'not_found'; end if;

  v_is_owner := v_customer is not null and v_reg.customer_id = v_customer;
  v_is_staff := public.auth_is_manager(v_reg.tenant_id);

  -- Identical answer for "no such registration" and "not yours", so walking
  -- UUIDs tells an attacker nothing.
  if not (v_is_owner or v_is_staff) then return 'not_found'; end if;

  -- The lock, before any state is read for a decision.
  v_event_id := v_reg.event_id;
  select e.id, e.status, e.starts_at into v_lock, v_ev_status, v_ev_starts
    from public.events e where e.id = v_event_id for update;

  -- Re-read under the lock: a concurrent cancellation or a webhook may have
  -- moved it between the ownership check and here.
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;

  if v_reg.status = 'cancelled' then return 'already_cancelled'; end if;
  if v_reg.status = 'checked_in' and not v_is_staff then return 'checked_in'; end if;

  -- A customer cannot walk away once the event has started or finished: that
  -- would turn a paid entry into a refund request after the venue has already
  -- delivered (or committed to) the event. Staff are not bound by this.
  if not v_is_staff
     and (v_ev_status in ('in_progress', 'completed') or v_ev_starts <= now()) then
    return 'too_late';
  end if;

  -- Did this entry hold a place? Decides whether anyone can be promoted.
  v_was_held := v_reg.status in ('registered', 'checked_in')
             or (v_reg.status = 'pending_payment' and v_reg.payment_hold_expires_at > now());

  update public.event_registrations
     set status = 'cancelled',
         cancelled_at = now(),
         payment_hold_expires_at = null,
         -- Money already taken cannot be handed back automatically — this
         -- codebase never auto-refunds (see 0047). It raises a flag a human
         -- works through, and leaves paid_amount / payment_reference exactly
         -- where they are so the history survives.
         refund_required = (v_reg.refund_required or v_reg.paid_amount > 0),
         -- A registration that already owed money back (a duplicate capture) and
         -- is now cancelled owes THAT plus the original payment. The trigger only
         -- sets the amount on a false -> true flip, so add it here when the flag
         -- was already raised; otherwise leave the trigger-managed amount alone.
         refund_due_amount = case
           when v_reg.refund_required and v_reg.paid_amount > 0
             then v_reg.refund_due_amount + v_reg.paid_amount
           else refund_due_amount end
   where id = p_registration_id;

  -- A team's entry IS the team. Withdrawing it releases the name and stops
  -- anyone joining what is no longer entered.
  if v_reg.team_id is not null then
    update public.event_teams set status = 'withdrawn' where id = v_reg.team_id;
  end if;

  perform public.expire_event_registration_holds(v_event_id);
  if v_was_held then
    perform public.promote_event_waitlist(v_event_id);
  end if;

  -- audit_log (0018), reused rather than a second trail — the same choice the
  -- customer booking cancellation made. actor_membership_id stays null because
  -- the actor may be a customer; who it was is recorded in the payload.
  insert into public.audit_log
    (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
  values (
    v_reg.tenant_id,
    null,
    case when v_is_owner then 'event_registration.cancelled_by_customer'
                         else 'event_registration.cancelled_by_staff' end,
    'event_registration',
    p_registration_id,
    jsonb_build_object('status', v_reg.status, 'paidAmount', v_reg.paid_amount),
    jsonb_build_object(
      'status', 'cancelled',
      'customerId', v_reg.customer_id,
      'refundRequired', v_reg.paid_amount > 0
    )
  );

  return 'cancelled';
end;
$$;
revoke all on function public.cancel_event_registration(uuid) from public;
grant execute on function public.cancel_event_registration(uuid) to arena_app;

create or replace function public.mark_event_registration_refunded(
  p_registration_id uuid,
  p_amount          numeric,
  p_reference       text
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_reg  public.event_registrations%rowtype;
  v_lock uuid;
begin
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;
  if not found then return 'not_found'; end if;
  if not public.auth_is_manager(v_reg.tenant_id) then return 'not_found'; end if;

  select e.id into v_lock from public.events e where e.id = v_reg.event_id for update;
  select * into v_reg from public.event_registrations r where r.id = p_registration_id;

  if not v_reg.refund_required then return 'not_flagged'; end if;
  if p_reference is null or btrim(p_reference) = '' then return 'reference_required'; end if;
  if p_amount is null or p_amount <= 0 then return 'invalid_amount'; end if;
  if p_amount > v_reg.refund_due_amount then return 'amount_exceeds_due'; end if;

  update public.event_registrations
     -- Partial refunds keep the balance outstanding: the flag stays up until
     -- nothing is owed.
     set refund_required   = (v_reg.refund_due_amount - p_amount) > 0,
         refund_due_amount = greatest(v_reg.refund_due_amount - p_amount, 0),
         refunded_amount   = refunded_amount + p_amount,
         refund_reference  = btrim(p_reference),
         refunded_at       = now()
   where id = p_registration_id;

  insert into public.audit_log
    (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
  values (
    v_reg.tenant_id, public.auth_membership_id(v_reg.tenant_id), 'event_registration.refunded', 'event_registration', p_registration_id,
    jsonb_build_object('refundRequired', true, 'refundDueAmount', v_reg.refund_due_amount),
    jsonb_build_object('refundRequired', (v_reg.refund_due_amount - p_amount) > 0,
                       'refundedAmount', p_amount,
                       'remainingDue', greatest(v_reg.refund_due_amount - p_amount, 0),
                       'refundReference', btrim(p_reference))
  );
  return 'refunded';
end;
$$;
revoke all on function public.mark_event_registration_refunded(uuid, numeric, text) from public;
grant execute on function public.mark_event_registration_refunded(uuid, numeric, text) to arena_app;
