-- ============================================================================
-- Arena OS — 0085 registration check-in token (M15 #5)
--
-- One column, so a registrant can be checked in from a QR code.
--
-- ══ THE SAME TOKEN PATTERN AS bookings.confirmation_token (0026) ════════════
--
-- Not a new scheme. 0026 established how this codebase identifies something a
-- stranger may present at the counter:
--
--     confirmation_token uuid not null default gen_random_uuid()
--     unique (tenant_id, confirmation_token)
--
-- and 0055 already reused it once for resource QR tokens. This is the third
-- use, unchanged, because the properties the ticket asks for are exactly the
-- ones that pattern already has:
--
--   UNGUESSABLE   gen_random_uuid() is v4 from pgcrypto's CSPRNG — 122 random
--                 bits. Not a sequence, not the registration id, not the
--                 customer id, not a phone number, and not derived from any of
--                 them, so possession of one token tells you nothing about any
--                 other.
--   UNIQUE        globally by the index below, and per-tenant by the composite
--                 one, so a scan resolves to exactly one row.
--   TENANT-SAFE   every lookup is `where tenant_id = <session tenant> and
--                 check_in_token = <scanned>`. The tenant comes from the staff
--                 session, never from the scanned string, so tenant A scanning
--                 tenant B's QR matches nothing — the composite unique index is
--                 what makes that lookup exact rather than merely likely.
--   INDEXED       both indexes below.
--
-- ══ WHAT THE QR CARRIES, AND WHAT IT DOES NOT ═══════════════════════════════
--
-- The token and nothing else. No customer id, no name, no phone, no amount, no
-- payment reference, no event id — a QR is a bearer credential that gets
-- photographed, screenshotted and forwarded, and anything encoded in it is
-- effectively public. Everything the check-in screen displays is read from the
-- database AFTER the token resolves, under the staff member's own RLS context.
--
-- ══ WHY NOT NULLABLE, AND WHY NO BACKFILL STEP ══════════════════════════════
--
-- `not null default gen_random_uuid()` means Postgres fills every existing row
-- as part of the ALTER, and every future insert gets one without any writer
-- having to remember. A nullable column would leave "registered before 0085"
-- as a second state the check-in path had to handle, and the first registrant
-- who hit it would be told their QR was invalid.
-- ============================================================================

alter table public.event_registrations
  add column if not exists check_in_token uuid not null default gen_random_uuid();

-- Globally unique: two registrations must never share a token even across
-- tenants, so a scan can never be ambiguous before the tenant filter applies.
create unique index if not exists idx_event_registrations_check_in_token
  on public.event_registrations(check_in_token);

-- THE lookup the scan performs, in the order it performs it. Composite so the
-- tenant predicate is part of the index rather than a filter applied after it.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.event_registrations'::regclass
       and conname  = 'event_registrations_tenant_token_key'
  ) then
    alter table public.event_registrations
      add constraint event_registrations_tenant_token_key unique (tenant_id, check_in_token);
  end if;
end $$;

comment on column public.event_registrations.check_in_token is
  'Unguessable bearer credential for day-of QR check-in (M15 #5). Same pattern as bookings.confirmation_token (0026): a v4 uuid, never derived from any id, resolved only as (tenant_id, check_in_token) under a staff session. The QR encodes this and nothing else — no customer, payment or event data.';

-- ── no policy or grant change ───────────────────────────────────────────────
--
-- Deliberately none. `event_registrations` already has its policies and grants
-- from 0081, and a new column inherits them exactly:
--
--   * a MANAGER reads and writes their own tenant's rows
--     (event_registrations_select / event_registrations_manager_write);
--   * a CUSTOMER reads only their own rows, under the restrictive customer
--     isolation policy — so a registrant can see their OWN token, which is the
--     point: it is what their QR renders from.
--
-- Nothing new is exposed. The token is not selected by any public reader:
-- lib/events/public.ts and the public event page never touch this table, and
-- the customer portal reader (listMyEventRegistrations) selects an explicit
-- column list, so the token reaches a browser only where a QR is deliberately
-- rendered for its own owner.
