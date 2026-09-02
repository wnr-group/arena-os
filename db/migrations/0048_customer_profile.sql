-- ============================================================================
-- Arena OS — 0048 customer profile & preferences (portal)
--
-- Two things: the communication-preference columns the customers table does not
-- have, and a way for a customer to edit their own profile that CANNOT reach
-- the columns they must not touch.
-- ============================================================================

-- ── 1. communication preferences ────────────────────────────────────────────
-- `customers` (0014) carries name, email, dob, tags and membership_status.
-- There is no opt-in of any kind, so these are new rather than a rename of
-- something existing.
--
-- DEFAULT TRUE, deliberately. These gate service messages about a booking the
-- customer actively made — confirmations, reminders, "your table is ready" —
-- and today every such message would go out because no preference exists at
-- all. Defaulting to false would silently switch off notifications for every
-- customer already on file the moment this migration runs. A future MARKETING
-- opt-in is a different flag and should default false; this is not that flag,
-- and the portal wording says "about your bookings" so the distinction stays
-- visible.
alter table public.customers
  add column if not exists sms_opt_in   boolean not null default true,
  add column if not exists email_opt_in boolean not null default true;

comment on column public.customers.sms_opt_in is
  'Customer consent for SMS about their own bookings. Not a marketing opt-in.';
comment on column public.customers.email_opt_in is
  'Customer consent for email about their own bookings. Not a marketing opt-in.';

-- ── 2. the customer's own profile edit ──────────────────────────────────────
--
-- ── Why this is a function and not an RLS policy ────────────────────────────
--
-- Every other customer write in this codebase is expressed as a narrow UPDATE
-- policy (see bookings_customer_cancel, 0047). That works there because the
-- rule is about the row's STATUS, and RLS can express it: USING inspects the
-- old row, WITH CHECK the new one.
--
-- It cannot work here. The rule this table needs is "these four columns may
-- change and the others may not", and RLS is row-level, not column-level:
-- WITH CHECK sees only the NEW row and has no way to say `phone = OLD.phone`.
-- So ANY update policy on `customers` would also permit a customer to rewrite:
--
--   * phone             — the LOGIN IDENTITY. OTP resolves an account by
--                         (tenant_id, phone), so a customer who can rewrite it
--                         can move their account onto a number they do not own,
--                         or park on one belonging to somebody who has not
--                         signed up yet. That is account takeover, not a
--                         profile edit.
--   * tags              — staff CRM annotations ("VIP", "banned").
--   * membership_status — staff-managed.
--
-- A column-level GRANT cannot narrow it either: staff writes travel through the
-- same arena_app role, so revoking column privileges would break the back
-- office.
--
-- Hence SECURITY DEFINER, the same device 0022 uses for public_tenant_by_slug()
-- and 0047 for customer_booking_meta(). The UPDATE below names exactly four
-- columns, so the other five are unreachable by construction — not by
-- convention, and not by remembering to write the application layer correctly.
--
-- The identity is NOT a parameter. It comes from current_customer_id(), which
-- withCustomer() sets transaction-locally from a validated session cookie, so
-- the caller cannot ask to edit anybody else's row. `customers` keeps NO
-- customer UPDATE policy and NO customer UPDATE grant at all.
create or replace function public.customer_update_profile(
  p_name         text,
  p_email        text,
  p_sms_opt_in   boolean,
  p_email_opt_in boolean
)
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_customer_id uuid := public.current_customer_id();
  v_updated     int;
begin
  -- No customer context (a staff transaction, the public booking path, or an
  -- unidentified connection) must never be able to call this into doing
  -- something. NULL = NULL is never true, but the guard is explicit so the
  -- function is safe to read rather than safe by accident.
  if v_customer_id is null then
    return false;
  end if;

  update public.customers
     set name         = nullif(btrim(coalesce(p_name, '')), ''),
         email        = nullif(lower(btrim(coalesce(p_email, ''))), ''),
         sms_opt_in   = coalesce(p_sms_opt_in, sms_opt_in),
         email_opt_in = coalesce(p_email_opt_in, email_opt_in)
   where id = v_customer_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

grant execute on function public.customer_update_profile(text, text, boolean, boolean)
  to arena_app;

-- No new grants or policies on `customers`. The customer context keeps exactly
-- what 0045 gave it — SELECT on its own row — and the function above is the
-- only way it can write anything at all.
