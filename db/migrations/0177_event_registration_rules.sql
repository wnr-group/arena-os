-- ============================================================================
-- Arena OS — 0177 event registration rules (review items left over from the
-- PR #18 review that PR #43 did not fix).
--
--   1. A member of a WITHDRAWN team was locked out. already_in_team ignored the
--      team's status, and idx_event_team_members_one_per_event kept the dead
--      row, so the captain and every member got already_in_team on any new
--      claim/join and could not leave. Withdrawing a team now removes its
--      member rows (trigger, so every path is covered), and claim/join only
--      count membership of an ACTIVE team. (A payment landing on a withdrawn
--      team's cancelled entry already stays cancelled and flagged — 0159 —
--      which this migration keeps.)
--   2. cancel_event_registration let a customer cancel on an in_progress or
--      completed event, or after it started, flagging a refund. Customers now
--      get 'too_late' from the event's start; staff are unaffected.
--   3. claim/join refused events.status = 'full' although 0139 says they take
--      it; 'full' is a capacity fact, so occupancy alone decides place vs
--      waitlist. public_event_taken_counts now counts 'full' events too.
--   4. Starting an event ('in_progress') while live pending_payment holds exist
--      made 0158 cancel the entry and flag a refund after the customer paid.
--      Refused at the database (the app pre-checks for a friendly message).
--   5. refund_required was never cleared and the report summed paid_amount of
--      cancelled rows. New columns hold the amount owed (refund_due_amount,
--      kept in step by a trigger and set explicitly for a second capture) and
--      what was refunded; mark_event_registration_refunded() clears the flag
--      and audits. The report keys off refund_required.
--   6. Raising capacity now promotes the waitlist (trigger on events).
-- ============================================================================

-- ── 5a. refund columns ──────────────────────────────────────────────────────
alter table public.event_registrations
  add column if not exists refund_due_amount numeric(10,2) not null default 0,
  add column if not exists refunded_amount   numeric(10,2) not null default 0,
  add column if not exists refund_reference  text,
  add column if not exists refunded_at       timestamptz;

-- The old report counted every cancelled, paid row as owed. Keep those figures
-- honest by flagging them (the venue can now mark each one refunded), then
-- record how much is owed on every flagged row.
update public.event_registrations
   set refund_required = true
 where status = 'cancelled' and payment_reference is not null and paid_amount > 0
   and refund_required = false and refunded_at is null;

update public.event_registrations
   set refund_due_amount = paid_amount
 where refund_required and refund_due_amount = 0;

-- Whatever sets refund_required (cancel_event_registration, the payment
-- webhook, cancelling an event) gets the amount filled in without each path
-- having to know about it. A path that sets the amount itself (a second
-- capture) is left alone.
create or replace function public.event_registrations_refund_amount()
returns trigger language plpgsql as $$
begin
  if new.refund_required and not old.refund_required
     and new.refund_due_amount = old.refund_due_amount then
    new.refund_due_amount := new.paid_amount;
  elsif not new.refund_required and old.refund_required
     and new.refund_due_amount = old.refund_due_amount then
    new.refund_due_amount := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_event_registrations_refund_amount on public.event_registrations;
create trigger trg_event_registrations_refund_amount
  before update of refund_required on public.event_registrations
  for each row execute function public.event_registrations_refund_amount();

-- ── 1. withdrawing a team removes its members ───────────────────────────────
create or replace function public.event_teams_release_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.event_team_members where team_id = new.id;
  return new;
end;
$$;
revoke all on function public.event_teams_release_members() from public;
drop trigger if exists trg_event_teams_release_members on public.event_teams;
create trigger trg_event_teams_release_members
  after update of status on public.event_teams
  for each row
  when (new.status = 'withdrawn' and old.status is distinct from 'withdrawn')
  execute function public.event_teams_release_members();

-- Teams withdrawn before this migration left their members behind.
delete from public.event_team_members m
 using public.event_teams t
 where t.id = m.team_id and t.status = 'withdrawn';

-- ── 4. never start an event over live payment holds ─────────────────────────
create or replace function public.guard_event_start_holds()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_holds integer;
begin
  select count(*)::int into v_holds
    from public.event_registrations r
   where r.event_id = new.id
     and r.status = 'pending_payment'
     and r.payment_hold_expires_at > now();
  if v_holds > 0 then
    raise exception 'Cannot start an event while % entrant(s) are part-way through paying.', v_holds
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_event_start_holds() from public;
drop trigger if exists trg_events_guard_start_holds on public.events;
create trigger trg_events_guard_start_holds
  before update of status on public.events
  for each row
  when (new.status = 'in_progress' and old.status is distinct from 'in_progress')
  execute function public.guard_event_start_holds();

-- ── 6. raising capacity promotes the waitlist ───────────────────────────────
create or replace function public.events_promote_on_capacity_raise()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('registration_open', 'full') then
    perform public.promote_event_waitlist(new.id);
  end if;
  return null;
end;
$$;
revoke all on function public.events_promote_on_capacity_raise() from public;
drop trigger if exists trg_events_promote_on_capacity_raise on public.events;
create trigger trg_events_promote_on_capacity_raise
  after update of capacity on public.events
  for each row
  when (old.capacity is distinct from new.capacity
        and (new.capacity is null or (old.capacity is not null and new.capacity > old.capacity)))
  execute function public.events_promote_on_capacity_raise();

-- ── claim_event_registration ───────────────────────────────────────────────
create or replace function public.claim_event_registration(
  p_event_id  uuid,
  p_team_name text default null
)
returns table (
  refusal             text,
  registration_id     uuid,
  registration_status public.event_registration_status,
  team_id             uuid,
  entry_fee           numeric
)
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_tenant   uuid;
  v_event    public.events%rowtype;
  v_status   public.event_registration_status;
  v_team     uuid;
begin
  refusal := null; registration_id := null; registration_status := null;
  team_id := null; entry_fee := null;

  if v_customer is null then
    refusal := 'not_signed_in'; return next; return;
  end if;
  v_tenant := public.current_customer_tenant_id();
  if v_tenant is null then
    refusal := 'not_signed_in'; return next; return;
  end if;

  -- THE lock. Everything after this line is serialised per event.
  --
  -- The tenant predicate is what makes another venue's event id useless: the
  -- tenant comes from the customer's own row (current_customer_tenant_id()
  -- looks it up inside the database), never from the caller.
  select * into v_event from public.events e
   where e.id = p_event_id and e.tenant_id = v_tenant
   for update;
  if not found then
    refusal := 'not_found'; return next; return;
  end if;

  entry_fee := v_event.entry_fee;

  -- Registration is a lifecycle question and only one status answers yes.
  if v_event.status not in ('registration_open', 'full') then
    refusal := 'not_open'; return next; return;
  end if;
  if v_event.ends_at <= now() then
    refusal := 'ended'; return next; return;
  end if;

  -- Bring the event up to date while we hold the lock: release dead holds, then
  -- let the queue take whatever that freed. Doing it here means the occupancy
  -- read below is the truth and not a stale count.
  perform public.expire_event_registration_holds(p_event_id);
  perform public.promote_event_waitlist(p_event_id);

  if exists (
    select 1 from public.event_registrations r
     where r.event_id = p_event_id
       and r.customer_id = v_customer
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    refusal := 'already_registered'; return next; return;
  end if;

  -- Playing for someone else's team already counts as being in this event.
  if exists (
    select 1 from public.event_team_members m
      join public.event_teams t on t.id = m.team_id and t.status = 'active'
     where m.event_id = p_event_id and m.customer_id = v_customer
  ) then
    refusal := 'already_in_team'; return next; return;
  end if;

  -- Solo vs team is the EVENT's rule, read from the row we just locked — never
  -- inferred from whether the browser happened to send a team name.
  if v_event.registration_mode = 'team' then
    if p_team_name is null or btrim(p_team_name) = '' then
      refusal := 'team_name_required'; return next; return;
    end if;
  elsif p_team_name is not null then
    refusal := 'not_a_team_event'; return next; return;
  end if;

  -- The decision, with the count taken under the lock.
  if v_event.capacity is not null
     and public.event_registration_occupancy(p_event_id) >= v_event.capacity then
    v_status := 'waitlisted';
  elsif v_event.entry_fee > 0 then
    v_status := 'pending_payment';
  else
    v_status := 'registered';
  end if;

  if v_event.registration_mode = 'team' then
    begin
      insert into public.event_teams (tenant_id, event_id, name, captain_customer_id)
      values (v_tenant, p_event_id, btrim(p_team_name), v_customer)
      returning id into v_team;
    exception when unique_violation then
      refusal := 'team_name_taken'; return next; return;
    end;

    insert into public.event_team_members (tenant_id, event_id, team_id, customer_id, is_captain)
    values (v_tenant, p_event_id, v_team, v_customer, true);
  end if;

  insert into public.event_registrations (
    tenant_id, event_id, customer_id, team_id, status,
    payment_hold_expires_at, registered_at, waitlisted_at
  ) values (
    v_tenant, p_event_id, v_customer, v_team, v_status,
    case when v_status = 'pending_payment' then now() + interval '30 minutes' end,
    case when v_status = 'registered'      then now() end,
    case when v_status = 'waitlisted'      then now() end
  )
  returning id into registration_id;

  registration_status := v_status;
  team_id := v_team;
  return next;
end;
$$;

-- ── join_event_team ────────────────────────────────────────────────────────
create or replace function public.join_event_team(p_team_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_customer uuid := public.current_customer_id();
  v_tenant   uuid;
  v_team     public.event_teams%rowtype;
  v_event    public.events%rowtype;
  v_members  integer;
begin
  if v_customer is null then return 'not_signed_in'; end if;
  v_tenant := public.current_customer_tenant_id();
  if v_tenant is null then return 'not_signed_in'; end if;

  select * into v_team from public.event_teams t
   where t.id = p_team_id and t.tenant_id = v_tenant;
  if not found then return 'not_found'; end if;

  select * into v_event from public.events e
   where e.id = v_team.event_id and e.tenant_id = v_tenant
   for update;
  if not found then return 'not_found'; end if;

  if v_event.registration_mode <> 'team' then return 'not_a_team_event'; end if;
  if v_event.status not in ('registration_open', 'full') then return 'not_open'; end if;
  if v_event.ends_at <= now() then return 'ended'; end if;
  if v_team.status <> 'active' then return 'team_withdrawn'; end if;

  -- The team's entry must still be live. A team whose registration was
  -- cancelled is not something anyone should be able to join into.
  if not exists (
    select 1 from public.event_registrations r
     where r.team_id = p_team_id
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    return 'team_withdrawn';
  end if;

  if exists (
    select 1 from public.event_registrations r
     where r.event_id = v_event.id and r.customer_id = v_customer
       and r.status in ('pending_payment', 'registered', 'waitlisted', 'checked_in')
  ) then
    return 'already_registered';
  end if;

  if exists (
    select 1 from public.event_team_members m
      join public.event_teams t on t.id = m.team_id and t.status = 'active'
     where m.event_id = v_event.id and m.customer_id = v_customer
  ) then
    return 'already_in_team';
  end if;

  select count(*) into v_members from public.event_team_members m where m.team_id = p_team_id;
  if v_members >= v_event.team_size then return 'team_full'; end if;

  insert into public.event_team_members (tenant_id, event_id, team_id, customer_id, is_captain)
  values (v_tenant, v_event.id, p_team_id, v_customer, false);

  return 'joined';
end;
$$;

-- ── cancel_event_registration ──────────────────────────────────────────────
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
         refund_required = (v_reg.paid_amount > 0)
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

-- ── confirm_event_registration_payment (0159 + refund_due_amount on already_paid) ──
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
       set refund_required = true,
           refund_due_amount = refund_due_amount + p_amount
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

-- ── 3. public_event_taken_counts: 'full' events are still listed ────────────
create or replace function public.public_event_taken_counts(p_tenant_id uuid)
returns table(event_id uuid, taken integer)
language sql stable security definer set search_path = public
as $$
  select r.event_id, count(*)::int
    from public.event_registrations r
    join public.events e on e.id = r.event_id
   where e.tenant_id = p_tenant_id
     and (p_tenant_id = public.current_public_tenant_id()
          or p_tenant_id in (select public.auth_tenant_ids()))
     and e.status in ('published', 'registration_open', 'full')
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     )
   group by r.event_id;
$$;
revoke all on function public.public_event_taken_counts(uuid) from public;
grant execute on function public.public_event_taken_counts(uuid) to arena_app;

-- ── 5b. mark a flagged refund as paid out ───────────────────────────────────
-- Manager-only, authorised from the registration's own tenant. Locks the event
-- like every other writer, so two clicks cannot both record the same refund:
-- the second finds the flag already clear.
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
     set refund_required   = false,
         refund_due_amount = 0,
         refunded_amount   = refunded_amount + p_amount,
         refund_reference  = btrim(p_reference),
         refunded_at       = now()
   where id = p_registration_id;

  insert into public.audit_log
    (tenant_id, actor_membership_id, action, entity_type, entity_id, "before", "after")
  values (
    v_reg.tenant_id, null, 'event_registration.refunded', 'event_registration', p_registration_id,
    jsonb_build_object('refundRequired', true, 'refundDueAmount', v_reg.refund_due_amount),
    jsonb_build_object('refundRequired', false, 'refundedAmount', p_amount,
                       'refundReference', btrim(p_reference))
  );
  return 'refunded';
end;
$$;
revoke all on function public.mark_event_registration_refunded(uuid, numeric, text) from public;
grant execute on function public.mark_event_registration_refunded(uuid, numeric, text) to arena_app;
