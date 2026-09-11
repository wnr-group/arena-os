-- ============================================================================
-- Arena OS — 0107 audit fixes for the WhatsApp group (0104) and Google review
-- (0105 / 0106) features.
--
-- Four unrelated corrections that happen to share a review. Each one is stated
-- with the finding it closes, so a later reader can tell what was wrong rather
-- than only what is now true.
-- ============================================================================

-- ── 1. eligibility could not use the index it needed (M1) ───────────────────
--
-- customer_review_eligible() filtered on customer_id ALONE:
--
--   where b.customer_id = public.current_customer_id()
--
-- Both supporting indexes lead with tenant_id —
--   idx_bookings_customer  (tenant_id, customer_id) where customer_id is not null
--   idx_orders_customer    (tenant_id, customer_id)
-- — so a customer_id-only predicate cannot do a two-column lookup. Postgres
-- falls back to walking the WHOLE index and filtering each entry, which is
-- work proportional to every booking and order on the PLATFORM rather than to
-- this one customer's rows. Confirmed with EXPLAIN: the plan showed
-- `Index Cond: (customer_id = …)` with no tenant_id, on every portal entry by
-- an un-answered customer at an enabled venue.
--
-- The tenant comes from the caller's OWN session GUC, never an argument, so
-- this narrows the query without widening what the function can reach. A
-- customer row is already per-tenant (customers.tenant_id, unique on
-- (tenant_id, phone)), so pinning the tenant cannot change WHICH rows match —
-- it only lets the planner find them.
create or replace function public.customer_review_eligible()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_customer_id() is not null
     and public.current_customer_tenant_id() is not null
     and (
       exists (
         select 1 from public.bookings b
          where b.tenant_id = public.current_customer_tenant_id()
            and b.customer_id = public.current_customer_id()
            and b.status in ('confirmed', 'checked_in', 'completed')
       )
       or exists (
         select 1 from public.orders o
          where o.tenant_id = public.current_customer_tenant_id()
            and o.customer_id = public.current_customer_id()
            and o.acceptance_status = 'accepted'
            and o.status <> 'cancelled'
       )
     );
$$;

revoke all on function public.customer_review_eligible() from public;
grant execute on function public.customer_review_eligible() to arena_app;

comment on function public.customer_review_eligible() is
  'Whether the current customer has a successful booking or order, and is therefore due the Google review prompt (0105, re-indexed 0107). Both EXISTS clauses are pinned to the caller''s own tenant GUC so they can use the (tenant_id, customer_id) indexes as a two-column lookup rather than walking the whole index. SECURITY DEFINER because a customer session has no policy on `orders`. Returns one boolean.';

-- ── 2. an index nothing ever read (L1) ──────────────────────────────────────
--
-- idx_customers_review_prompt_pending answered "which customers of this tenant
-- have not answered yet", a question no code in this project asks: the prompt
-- reader looks the customer up by PRIMARY KEY
-- (lib/portal/review-prompt.ts). pg_stat_user_indexes confirmed idx_scan = 0.
--
-- An unused index is not free — it is maintained on every insert and on every
-- update that touches the row. Dropped rather than kept "in case": the query
-- that would use it does not exist, and re-creating it is one line if a
-- tenant-facing "chase pending reviews" screen is ever built.
drop index if exists public.idx_customers_review_prompt_pending;

-- ── 3. one cached column that could never hold a value (L3) ─────────────────
--
-- review_url could never be anything but null — toGoogleReview() hard-codes it,
-- because the Review resource carries no public permalink (reviewReplyUrl is
-- for the OWNER to reply, not for a visitor to read). A column that is
-- structurally always null is a promise the schema cannot keep, so it goes.
--
-- Safe to drop outright: google_reviews is a CACHE. Every row is re-derivable
-- from Google on the next sync, so nothing is lost that the source does not
-- still hold.
--
-- ── why reviewer_photo_url STAYS ───────────────────────────────────────────
--
-- It is in the same position — written by every sync, rendered by nothing,
-- because GoogleReviewsSection deliberately draws initials instead: an <img>
-- pointing at googleusercontent would hotlink on every homepage render and leak
-- each visitor's IP to Google.
--
-- But unlike review_url it CAN hold a real value, and Google does return one.
-- So it is kept as an OPTIONAL field rather than dropped: nullable, written
-- when Google supplies it, depended on by nothing. That keeps an avatar UI a
-- rendering decision later instead of a re-sync, and costs one nullable text
-- column in a table that is already a cache.
--
-- What has NOT changed is the reason it is not rendered today. Keeping the
-- value is not permission to hotlink it — see GoogleReviewsSection.
alter table public.google_reviews
  drop column if exists review_url;

comment on column public.google_reviews.reviewer_photo_url is
  'The reviewer''s Google profile photo, when Google supplies one and the reviewer is not anonymous. OPTIONAL — stored but deliberately not rendered: the homepage draws initials, because an <img> here would hotlink googleusercontent on every render and leak each visitor''s IP to Google. Kept so an avatar UI stays a rendering decision rather than a re-sync (0107).';

comment on table public.google_reviews is
  'Cached Google Business Profile reviews for one tenant (0105, trimmed 0107). Written only by the sync; read by the public homepage. Every column here is already public on Google, which is why this has a plain public SELECT policy rather than the projection function business_profiles needs. No customer_id: Google does not say which of our customers wrote a review.';

-- ── 4. the connection was manager-writable under an owner-only screen (M2) ──
--
-- google_business_credentials_rw used auth_is_manager(), but the only screen
-- that reaches it — /settings/business — redirects anybody who is not the
-- owner. A server action is a public POST endpoint, so a manager who could not
-- SEE the form could still call saveGoogleOAuthClientAction() or
-- disconnectGoogleBusiness() directly, and bind their own Google Business
-- Profile to the venue or drop the owner's.
--
-- Resolved towards the STRICTER of the two, matching business_profiles, which
-- holds the very settings this feature sits beside (the WhatsApp invite and
-- the Google review link) and has been owner-only since 0020:
--
--   business_write:  auth_role_in(tenant_id) = 'owner'
--
-- Connecting an external identity to the business is the same KIND of act as
-- setting its legal name and GSTIN, so it gets the same gate. The application
-- guards were tightened to requireOwner() in the same change; this is the
-- second layer, so neither alone is load-bearing.
drop policy if exists google_business_credentials_rw on public.google_business_credentials;
create policy google_business_credentials_rw on public.google_business_credentials
  for all using (public.auth_role_in(tenant_id) = 'owner')
        with check (public.auth_role_in(tenant_id) = 'owner');

comment on table public.google_business_credentials is
  'One tenant''s connected Google Business Profile location and its encrypted refresh token (0105, owner-gated 0107). Owner-only — the same gate business_profiles uses, because connecting an external identity to the business belongs with its legal identity. Never public, never customer-readable. The token is AES-256-GCM sealed with the tenant id as AAD, so a ciphertext moved between rows cannot decrypt.';
