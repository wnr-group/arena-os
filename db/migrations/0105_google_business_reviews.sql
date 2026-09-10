-- ============================================================================
-- Arena OS — 0105 Google Business Profile: connection + review cache.
--
-- FEATURE B, and deliberately nothing to do with 0104. That one is a LINK we
-- send a customer to; this one is READING what Google already holds. They share
-- the word "review" and nothing else — different direction, different auth,
-- different failure modes — so they get different tables and neither can break
-- the other. A venue can run the customer prompt with no API access at all.
--
-- ══ TWO TABLES, BECAUSE THEY HAVE OPPOSITE EXPOSURE ═════════════════════════
--
--   google_business_credentials   a refresh token. NEVER public, never leaves
--                                 the server, manager-only, encrypted at rest.
--   google_reviews                what Google already shows the whole world.
--                                 Public by design — that is the point.
--
-- Putting them in one table would mean one RLS surface trying to be both, and
-- the public half would be one forgotten column projection away from leaking a
-- token. Separate tables make that mistake unavailable.
--
-- ══ WHY A CACHE AND NOT A LIVE CALL ════════════════════════════════════════
--
-- The homepage must not depend on Google being up, fast, or within quota. A
-- public page that makes a third-party API call per render is a page that goes
-- down when that third party does, and Business Profile quota is per PROJECT
-- (~300 QPM once approved, 0 before) — shared across every tenant, so one busy
-- venue would starve the rest. The sync writes here; the homepage only reads.
--
-- Staleness is the accepted trade: reviews change slowly, and a review that is
-- a few hours old is not wrong in any way a visitor would notice.
--
-- ══ WHAT GOOGLE ACTUALLY GIVES US ══════════════════════════════════════════
--
-- accounts.locations.reviews.list returns, per review: reviewer.displayName,
-- reviewer.profilePhotoUrl, reviewer.isAnonymous, starRating (an ENUM —
-- ONE..FIVE, not an integer), comment, createTime, updateTime, name.
--
-- The columns below are exactly that and no more. Note what is NOT here: there
-- is no customer_id, because Google does not tell us which of OUR customers
-- wrote a review — the reviewer is a display name on a Google account. That
-- absence is the same limitation 0104 documents, showing up in the schema.
--
-- ══ ACCESS IS NOT ASSUMED ══════════════════════════════════════════════════
--
-- Business Profile API access requires an application, a verified GBP live 60+
-- days, and a business website; and the `business.manage` scope is sensitive,
-- so a multi-tenant OAuth consent screen needs Google's app verification. Most
-- tenants will have neither. Everything here is therefore ABSENT-BY-DEFAULT: nowhat 
-- credentials row means no sync, no cached reviews, and a homepage that renders
-- exactly as it does today.
-- ============================================================================

-- ── 1. the connection ───────────────────────────────────────────────────────
--
-- One row per tenant; tenant_id IS the primary key, like payment_settings and
-- business_profiles. A tenant either has connected a location or has not.
create table if not exists public.google_business_credentials (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- Google's own identifiers for the connected location. The API's parent path
  -- is `accounts/{accountId}/locations/{locationId}`, so both halves are needed
  -- and both are stored as Google returns them — opaque strings, never parsed.
  google_account_id  text not null,
  google_location_id text not null,

  -- AES-256-GCM ciphertext, sealed with the TENANT ID as AAD — the same device
  -- lib/settings/razorpay-credentials.ts uses, and for the same reason: a
  -- ciphertext moved between tenant rows fails to decrypt rather than quietly
  -- authorising as the wrong venue.
  --
  -- The REFRESH token only. Access tokens live for an hour and are exchanged on
  -- demand; storing one would be storing a value that is stale before it is
  -- read, and would double the surface for nothing.
  -- ── the venue's OWN OAuth application ─────────────────────────────────
  --
  -- Per tenant, not per platform, and deliberately so.
  --
  -- The obvious design is one Arena OS OAuth client every venue consents
  -- to — the "Sign in with Google" shape. It gives nicer onboarding: the
  -- owner clicks Connect and never sees Google Cloud Console. It is not
  -- what this uses, because of where the real bottleneck sits:
  --
  --   QUOTA is per CLOUD PROJECT. One shared client means ~300 QPM split
  --   across every venue on the platform, so a busy one starves the rest,
  --   and the ceiling cannot be raised for one tenant.
  --
  --   VERIFICATION is per project too. business.manage is a sensitive
  --   scope, and a MULTI-TENANT app asking for it faces Google's harder
  --   review. A venue using its own project can authorise its own account
  --   without that review at all.
  --
  --   BLAST RADIUS. One suspended platform client stops every venue. One
  --   venue's misconfigured project stops only that venue.
  --
  -- The cost is real and worth stating plainly: each owner must create a
  -- Cloud project, enable the Business Profile API and make an OAuth
  -- client before connecting. That is a genuine onboarding step.
  oauth_client_id text not null,

  -- Sealed exactly like the refresh token, with the tenant id as AAD. The
  -- two are useless apart — a refresh token cannot be exchanged without
  -- its client secret — so they live together and are lost together.
  oauth_client_secret_encrypted text not null,

  -- NULLABLE, because the two halves arrive at different times.
  --
  -- An owner saves their OAuth client first, then clicks Authorise and is sent
  -- to Google; the refresh token only exists once they come back. NOT NULL
  -- here would have forced them to obtain a token by hand BEFORE the consent
  -- flow could run — exactly backwards.
  --
  -- Null therefore means "configured but not yet authorised", and the sync
  -- treats it exactly like no connection: nothing to do, not an error.
  refresh_token_encrypted text,

  -- Set when the owner completes consent; cleared by disconnecting.
  connected_at timestamptz not null default now(),

  -- ── sync bookkeeping, so a failing connection is visible ─────────────────
  --
  -- A sync that has been failing for a week must be findable without reading
  -- logs. Null error = the last run succeeded.
  last_synced_at    timestamptz,
  last_sync_error   text,
  last_sync_attempt timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_business_credentials enable row level security;

-- Manager-only, exactly like payment_settings — connecting a Google Business
-- Profile is an administrative act, not a floor operation.
--
-- There is deliberately NO public policy and NO customer policy of any kind.
-- The only reader is lib/reviews/google-credentials.ts, on the owner
-- connection, which is why that file exists as its own module: `grep -r
-- google-credentials` enumerates every caller in the project.
drop policy if exists google_business_credentials_rw on public.google_business_credentials;
create policy google_business_credentials_rw on public.google_business_credentials
  for all using (public.auth_is_manager(tenant_id))
        with check (public.auth_is_manager(tenant_id));

drop trigger if exists trg_google_business_credentials_updated on public.google_business_credentials;
create trigger trg_google_business_credentials_updated
  before update on public.google_business_credentials
  for each row execute function public.set_updated_at();

comment on table public.google_business_credentials is
  'One tenant''s connected Google Business Profile location and its encrypted refresh token (0105). Manager-only, never public, never customer-readable. The token is AES-256-GCM sealed with the tenant id as AAD, so a ciphertext moved between rows cannot decrypt.';

-- ── 2. the cache ────────────────────────────────────────────────────────────
create table if not exists public.google_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Google's own review id (from the resource name). THE idempotency key: a
  -- re-sync updates the row it already wrote rather than appending a duplicate.
  google_review_id text not null,

  -- Null when the reviewer chose to stay anonymous (reviewer.isAnonymous), a
  -- case Google genuinely returns — the UI says "A Google user".
  reviewer_name       text,
  reviewer_photo_url  text,

  -- Google's starRating is an ENUM (ONE..FIVE). It is mapped to 1..5 at the
  -- edge (lib/reviews/google-business-api.ts) so nothing downstream has to know
  -- that, and the CHECK is what stops a bad mapping reaching the homepage.
  rating smallint not null check (rating between 1 and 5),

  -- Google allows a rating with no words at all, so this is nullable and the
  -- homepage simply shows the stars.
  comment text,

  -- Google's createTime, NOT when we synced it. Ordering by our sync time would
  -- reshuffle the homepage every time the job ran.
  review_created_at timestamptz not null,

  -- A deep link back to the review on Google, when one is available.
  review_url text,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One row per review per tenant. An INDEX, not an application check: two
  -- concurrent syncs both inserting cannot both win.
  constraint google_reviews_tenant_review_key unique (tenant_id, google_review_id)
);

-- The homepage's only read: this tenant's reviews, newest first.
create index if not exists idx_google_reviews_tenant_recent
  on public.google_reviews(tenant_id, review_created_at desc);

alter table public.google_reviews enable row level security;

-- Staff read their own tenant's, as with every other tenant-scoped table.
drop policy if exists google_reviews_select on public.google_reviews;
create policy google_reviews_select on public.google_reviews
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- ── and the public one ──────────────────────────────────────────────────────
--
-- A plain policy rather than a SECURITY DEFINER projection — the opposite of
-- the choice 0104 made for business_profiles, and worth saying why:
--
--   business_profiles holds the GSTIN, legal name and registered address beside
--   the review URL, so a row-level policy would expose all of it. THIS table
--   holds nothing that is not already public on Google's own listing — a
--   display name, a star rating, and words the reviewer chose to publish. There
--   is no private column for a policy to leak, so the simplest mechanism is
--   also the safest one, and a function would only add indirection.
--
-- Scoped to the tenant withPublicTenant() pinned from the subdomain, so one
-- venue's homepage can never render another's reviews.
drop policy if exists google_reviews_public_select on public.google_reviews;
create policy google_reviews_public_select on public.google_reviews
  for select using (tenant_id = public.current_public_tenant_id());

-- No public INSERT/UPDATE/DELETE of any kind. The sync writes on the owner
-- connection; nothing reachable from a browser can write a review row.

comment on table public.google_reviews is
  'Cached Google Business Profile reviews for one tenant (0105). Written only by the sync; read by the public homepage. Every column here is already public on Google, which is why this has a plain public SELECT policy rather than the projection function business_profiles needs. No customer_id: Google does not say which of our customers wrote a review.';

-- ── 3. grants ───────────────────────────────────────────────────────────────
--
-- `arena_app` is the APP role every request connects as; without these it can
-- reach neither table and RLS never even gets consulted (42501 is a GRANT
-- error, not a policy one). Stated per table, the same way 0076 and every other
-- table-creating migration states them.
--
-- google_reviews gets the full set because the SYNC also runs as the app role
-- in tests; in production it runs as the owner. The public path is confined by
-- google_reviews_public_select above, which is SELECT-only — a grant is not a
-- policy, and the policy is what decides which rows.
grant select, insert, update, delete on public.google_reviews to arena_app;

-- The credentials table is app-readable ONLY so a manager-session settings
-- screen can show connection status through google_business_credentials_rw.
-- The refresh token itself is read by lib/reviews/google-credentials.ts on the
-- OWNER connection, which does not depend on this grant.
grant select, insert, update, delete on public.google_business_credentials to arena_app;
