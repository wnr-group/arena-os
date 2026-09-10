-- ============================================================================
-- Arena OS — 0104 Google review prompt, per tenant and per customer.
--
-- Two columns on `business_profiles` (the venue's link), ONE column on
-- `customers` (that customer's answer), and one narrow reader. No new table.
--
-- ══ WHY NO customer_google_review_status TABLE ══════════════════════════════
--
-- The spec sketches a table holding (tenant_id, customer_id, eligible,
-- review_completed, eligible_since, …). Two of those are derivable and one is
-- not, and separating them is what keeps this small:
--
--   ELIGIBLE is a QUESTION, not a fact to store. "Has this customer a
--   successful booking or a successful order?" is already answered by
--   `bookings` and `orders`. Storing it would mean writing to a new table from
--   the booking and order paths — which the spec also forbids — and would then
--   need reconciling every time a booking is cancelled. Derived, it is always
--   right, needs no write on any hot path, and gives "one prompt per customer"
--   for free: five bookings cannot produce five prompts because there is
--   nothing to produce five OF.
--
--   COMPLETED is a genuine fact nothing else records, so it is stored.
--
-- And it belongs on `customers` because a customer row IS per-tenant here:
-- `customers.tenant_id` with a unique (tenant_id, phone), and every composite
-- FK to it carries tenant_id. So "one prompt state per tenant + customer" and
-- "one column on the customer row" are the same statement — the unique
-- constraint the spec asks for is the primary key that already exists.
--
-- It is also the same shape as `sms_opt_in` / `email_opt_in`: a customer-owned
-- preference the customer sets themselves, written the SAME way those are —
-- through a column-naming SECURITY DEFINER function (see §4), because a
-- customer session has no UPDATE policy on `customers` and should not get one.
-- A separate table would have needed its own policies to say the same thing.
--
-- ══ WHAT "COMPLETED" MEANS — READ THIS BEFORE TRUSTING THE COLUMN ═══════════
--
-- `google_review_prompt_completed_at` records that the CUSTOMER TOLD US they
-- left a review. It is NOT confirmation from Google.
--
-- Google's review URL is a one-way link: no callback, no postMessage, no
-- per-customer submission signal. Even a tenant with full Business Profile API
-- access could not close that gap — reviews.list is scoped to a LOCATION and
-- returns a reviewer display name, not an Arena OS customer id, so attributing
-- a review to the person who clicked is guesswork. Scraping is not an option.
--
-- So the column is named for the PROMPT, not the review: the prompt is
-- completed, which is all this application can honestly know. It is set only by
-- an explicit "I've left my review" action, never by the click that opens
-- Google — treating a click as completion would be a claim the schema then
-- makes permanent.
--
-- ══ TENANT ISOLATION ═══════════════════════════════════════════════════════
--
-- The link reader pins the tenant to the caller's OWN session — the public GUC
-- or the customer GUC, never an argument alone — so a customer of one venue
-- cannot resolve another venue's URL by passing its id. The completion column
-- sits on the customer's own row, which customers_customer_isolation already
-- confines to `id = current_customer_id()`.
-- ============================================================================

-- ── 1. the venue's link ─────────────────────────────────────────────────────
alter table public.business_profiles
  add column if not exists google_review_url text,
  add column if not exists google_review_enabled boolean not null default false;

-- The same host allowlist normalizeGoogleReviewUrl() applies in
-- lib/settings/google-review.ts, stated here for the same reason
-- validateEventFields() mirrors 0088's CHECKs: the application gives a
-- sentence, the database gives the guarantee. A row that could send a customer
-- somewhere other than Google cannot be written, even by SQL.
do $$ begin
  alter table public.business_profiles
    add constraint business_profiles_google_review_url check (
      google_review_url is null
      or google_review_url ~ '^https://(g\.page/|maps\.app\.goo\.gl/|goo\.gl/maps/|search\.google\.com/local/writereview\?|(www\.|maps\.|search\.)?google\.[a-z.]{2,6}/maps)'
    );
exception when duplicate_object then null; end $$;

-- Enabled implies a link. Stated as an implication so "switched on with nothing
-- to point at" is unrepresentable — the same device event_registrations_hold
-- (0091) and business_profiles_whatsapp_group_enabled (0103) use.
do $$ begin
  alter table public.business_profiles
    add constraint business_profiles_google_review_enabled check (
      not google_review_enabled or google_review_url is not null
    );
exception when duplicate_object then null; end $$;

comment on column public.business_profiles.google_review_url is
  'Canonical Google review link. Host-pinned by CHECK because every eligible customer is offered it (0104).';

comment on column public.business_profiles.google_review_enabled is
  'Whether eligible customers see the review prompt. Disabling HIDES the prompt and preserves every completion state, so re-enabling resumes rather than restarts (0104).';

-- ── 2. the customer's answer ────────────────────────────────────────────────
alter table public.customers
  add column if not exists google_review_prompt_completed_at timestamptz;

comment on column public.customers.google_review_prompt_completed_at is
  'When this customer said they had left a Google review — SELF-DECLARED, never confirmed by Google, which provides no per-customer submission signal for a review-link flow. Null means the prompt is still pending. Set only by the customer''s own explicit confirmation, never by the click that opens Google (0104).';

-- Only the pending, and only this tenant's: the prompt reader's exact question.
-- Partial, because a customer who has answered is never asked again and a row
-- carrying a timestamp is dead weight in this index.
create index if not exists idx_customers_review_prompt_pending
  on public.customers(tenant_id)
  where google_review_prompt_completed_at is null;

-- ── 3. the link, for the surfaces that may not read business_profiles ───────
--
-- business_profiles is owner-only (business_select). The customer portal and
-- the public site both need the URL and neither has that access, so this is the
-- same SECURITY DEFINER projection public_tenant_by_slug (0022) and
-- public_whatsapp_group (0103) use: one scalar out, the GSTIN and registered
-- address stay closed.
--
-- The tenant is pinned to the CALLER'S OWN session — the public GUC that
-- withPublicTenant() sets from the subdomain, or the customer GUC that
-- withCustomer() sets from the verified OTP session. `p_tenant_id` cannot
-- select a row on its own: another venue's id returns null, not that venue's
-- link.
create or replace function public.public_google_review(p_tenant_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select b.google_review_url
    from public.business_profiles b
   where b.tenant_id = p_tenant_id
     and b.tenant_id in (
       public.current_public_tenant_id(),
       public.current_customer_tenant_id()
     )
     and b.google_review_enabled
     and b.google_review_url is not null;
$$;

revoke all on function public.public_google_review(uuid) from public;
grant execute on function public.public_google_review(uuid) to arena_app;

comment on function public.public_google_review(uuid) is
  'The tenant''s Google review link for the customer portal and the public site (0104). SECURITY DEFINER so neither path reads business_profiles, which holds the GSTIN, legal name and registered address. Returns one scalar, only when the owner has enabled it, and only for the tenant the caller''s own session is pinned to.';

-- ── 4. the two things a customer session cannot do directly ─────────────────
--
-- A customer transaction (withCustomer) can SELECT its own `customers` row, and
-- nothing else this feature needs:
--
--   * there is NO permissive UPDATE policy on `customers` for a customer —
--     customers_customer_isolation is RESTRICTIVE, which narrows and never
--     grants — so the prompt could not be marked answered;
--   * there is NO customer policy on `orders` at all (only staff and the public
--     tenant GUC), so an order could never be seen from the portal.
--
-- Both are solved the way customer_update_profile() (0048) already solves the
-- first: a SECURITY DEFINER function that NAMES what it touches. That is
-- column-level and row-level restriction expressed in a place RLS cannot
-- express it, and it is why neither of these needs a new policy — widening
-- `customers` to customer UPDATE would hand over name, phone, tags and
-- membership_status to buy one timestamp.
--
-- Both read the customer from current_customer_id(), never from an argument, so
-- there is no parameter through which one customer could act as another.

-- Is the CURRENT customer eligible? One boolean out; no booking or order detail
-- crosses the boundary. Reads past RLS by design — that is the whole reason it
-- exists — and is confined to the caller's own rows by the WHERE clauses.
create or replace function public.customer_review_eligible()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_customer_id() is not null
     and (
       exists (
         select 1 from public.bookings b
          where b.customer_id = public.current_customer_id()
            and b.status in ('confirmed', 'checked_in', 'completed')
       )
       or exists (
         select 1 from public.orders o
          where o.customer_id = public.current_customer_id()
            and o.acceptance_status = 'accepted'
            and o.status <> 'cancelled'
       )
     );
$$;

revoke all on function public.customer_review_eligible() from public;
grant execute on function public.customer_review_eligible() to arena_app;

comment on function public.customer_review_eligible() is
  'Whether the current customer has a successful booking or order, and is therefore due the Google review prompt (0104). SECURITY DEFINER because a customer session has no policy on `orders`. Returns one boolean — no booking or order detail crosses the boundary. Derived, never stored, so five bookings cannot become five prompts.';

-- Record the customer's OWN statement that they left a review. Names the single
-- column it may write, so this cannot become a general customer-write door.
-- `is null` makes it idempotent: a replay keeps the first answer's timestamp.
create or replace function public.customer_complete_review_prompt()
returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_customer_id uuid := public.current_customer_id();
  v_updated     int;
begin
  -- A staff transaction, the public path, or an unidentified connection must
  -- never be able to call this into doing something. Explicit, so the function
  -- is safe to READ rather than safe by accident — same guard as 0048.
  if v_customer_id is null then
    return false;
  end if;

  update public.customers
     set google_review_prompt_completed_at = now()
   where id = v_customer_id
     and google_review_prompt_completed_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.customer_complete_review_prompt() from public;
grant execute on function public.customer_complete_review_prompt() to arena_app;

comment on function public.customer_complete_review_prompt() is
  'Marks the current customer''s Google review prompt answered (0104). SELF-DECLARED — Google provides no per-customer submission signal, so this records what the customer said and nothing stronger. SECURITY DEFINER and column-named because a customer session has no UPDATE policy on `customers`, and widening one would expose name, phone and tags to buy one timestamp. Idempotent.';
