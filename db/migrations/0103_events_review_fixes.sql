-- ============================================================================
-- Arena OS — 0103 events: refund flagging, the `full` status, and recurring
-- resource inheritance. Three review findings, all in the database half.
--
-- ══ 1. A SECOND CAPTURE MUST FLAG A REFUND ═════════════════════════════════
--
-- confirm_event_registration_payment() returned 'already_paid' and wrote
-- nothing. `already_paid` is listed in REFUND_OUTCOMES
-- (lib/payments/event-registration-payment.ts) and documented there as "a
-- SECOND, distinct, verified-and-captured payment ... so it is refund-required"
-- — but the row was never flagged, no audit entry was written, and
-- lib/payments/webhook.ts short-circuited before even reaching this function.
-- Real money, captured, with nothing in the system saying it was owed back and
-- nothing in idx_event_registrations_refund_required to find it by.
--
-- The branch now does what its two siblings already do. The webhook's early
-- return is removed in the same change; the redelivery case (the SAME payment
-- id arriving twice) still short-circuits there, because that owes nothing.
--
-- ══ 2. `full` IS A CAPACITY FACT, NOT A CLOSED DOOR ════════════════════════
--
-- claim_event_registration() accepted only 'registration_open'. So an event at
-- capacity waitlisted the next entrant, while the SAME event with a manager's
-- "Full" badge on it refused them outright — the same underlying situation
-- giving opposite answers depending on the order two unrelated actions
-- happened in, and silently removing the waitlist from any venue that used the
-- button. 'full' now takes the identical path; occupancy alone decides place
-- versus waitlist.
--
-- The reader half is in lib/events/types.ts, which also had to stop hiding a
-- 'full' event from the public listing it is still legitimately part of.
--
-- ══ 3. A RECURRING SERIES CAN NOW RESERVE ITS RESOURCES ════════════════════
--
-- event_series carried no resource columns, so every generated occurrence was
-- written with resource_scope = 'none' (the events default) and held nothing —
-- while being created in 'registration_open', a status that is supposed to
-- reserve. A weekly class therefore left its court bookable by anyone, every
-- week, forever, and 0100's header claiming occurrences get the "same resource
-- blocking" was not true.
--
-- The template now carries the scope, and the job copies it. Materialising the
-- BLOCKS stays in the job (scripts/run-recurring-events.ts) through the same
-- syncEventBlocks() the settings screen uses, rather than being reimplemented
-- in SQL here — one implementation of "what does this event reserve", which is
-- the whole point of migration 0094.
-- ============================================================================

-- ── 1. refund flagging on a second capture ──────────────────────────────────
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
    -- A DIFFERENT payment against an already-settled registration.
    --
    -- The place is NEVER granted twice — that would charge the entry fee
    -- twice for one entry. But the money is real, verified and captured, so
    -- it is owed BACK, and that has to be recorded where an operator will
    -- find it: refund_required (which idx_event_registrations_refund_required
    -- indexes) plus an audit row, exactly as the amount_mismatch and
    -- unfulfillable branches below already do. Returning the code alone left
    -- captured money with no trace but a 'rejected' webhook_events row.
    --
    -- paid_amount and payment_reference are deliberately NOT overwritten:
    -- they describe the payment that actually bought this place. Which
    -- payment succeeded and which is owed back are separate facts, so the
    -- second payment is named in the audit entry instead.
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

  -- The money must equal the event's OWN fee. The browser never supplied this
  -- number and neither did the gateway: it is read from the event row here, in
  -- the same transaction that is about to confirm the place.
  --
  -- A mismatch means the fee moved between checkout and capture. The place is
  -- NOT granted for money that does not match the advertised price, and the
  -- money is not kept quietly either: the entry is cancelled and flagged, which
  -- is the same landing the "place is gone" case below uses.
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

  -- Already holds a place (a free-then-repriced event, or a manual staff
  -- confirmation that beat the webhook). Record the money against the entry it
  -- paid for and change nothing else — cancelling a confirmed entrant because
  -- their payment arrived would be absurd.
  if v_reg.status in ('registered', 'checked_in') then
    update public.event_registrations
       set paid_amount = p_amount,
           payment_reference = p_payment_reference,
           refund_required = false
     where id = p_registration_id;
    return 'confirmed';
  end if;

  -- Is there a place for them? Counted EXCLUDING this registration, so the
  -- answer is the same whether their own hold is still live (it is, and the
  -- count is one short of capacity) or expired while they were paying (it is
  -- not, and they take a place only if one is genuinely free).
  select count(*)::int into v_occ
    from public.event_registrations r
   where r.event_id = v_reg.event_id
     and r.id <> p_registration_id
     and (
       r.status in ('registered', 'checked_in')
       or (r.status = 'pending_payment' and r.payment_hold_expires_at > now())
     );

  if v_event.capacity is not null and v_occ >= v_event.capacity then
    -- Paid, but the place is gone. Capacity is the invariant that does not
    -- bend, so the entry is cancelled and flagged for a refund — the customer
    -- is never left silently charged with nothing to show for it.
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

-- ── 3. a series carries what its occurrences reserve ────────────────────────
--
-- Same vocabulary as events.resource_scope (0094), reusing that enum rather
-- than declaring a parallel one, so "what does this reserve" has exactly one
-- meaning across templates and occurrences. Defaults to 'none', which is what
-- every existing series already behaves as — nothing changes until an owner
-- picks a scope.
alter table public.event_series
  add column if not exists resource_scope public.event_resource_scope not null default 'none';

comment on column public.event_series.resource_scope is
  'What each generated occurrence reserves (0103). Copied onto the occurrence, which then materialises booking_slots through syncEventBlocks() exactly as a hand-created event does. ''none'' by default, so an untouched series behaves as before.';

-- A series templates 'none' or 'branch' only. 'specific' names individual
-- stations, and a template has nowhere to keep that list — the occurrence would
-- have to inherit resource ids that may not exist by the time it is generated.
-- Refused here rather than silently degraded, so a manager finds out at save
-- time instead of discovering an unblocked court weeks later.
do $$ begin
  alter table public.event_series
    add constraint event_series_resource_scope check (resource_scope in ('none', 'branch'));
exception when duplicate_object then null; end $$;
