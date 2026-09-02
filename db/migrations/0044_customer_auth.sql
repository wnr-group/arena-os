-- ============================================================================
-- Arena OS — 0044 customer auth (AROS-87): phone/OTP login for the customer
-- portal on a tenant subdomain.
--
-- Two tables, deliberately on OPPOSITE sides of the RLS boundary, because they
-- are two different kinds of secret:
--
--   customer_otp_challenges — a short-lived, tenant-scoped challenge. Written
--     and read by the PUBLIC (no-login) request path, so it is granted to
--     arena_app and pinned by app.public_tenant_id exactly like the public
--     booking tables in 0022/0023.
--
--   customer_sessions — identity infrastructure, the customer-side twin of
--     `sessions` (0001). Same posture as its staff counterpart: NOT granted to
--     arena_app at all, reachable only through the owner connection. A tenant
--     query can therefore never enumerate session tokens, for either audience.
--
-- The two audiences never mix. `sessions` authenticates a `users` row (staff);
-- `customer_sessions` authenticates a `customers` row. They have separate
-- tables, separate cookies (lib/auth/cookie.ts vs lib/auth/customer-cookie.ts)
-- and separate resolvers, so a token from one is meaningless to the other.
-- ============================================================================

-- ── customer_otp_challenges ─────────────────────────────────────────────────
-- One row per "send me a code" request. The code itself is NEVER stored: the
-- column holds an HMAC-SHA-256 (lib/otp/challenge.ts) keyed by a server-side
-- secret and bound to (challenge id, tenant, phone). A 6-digit code has only
-- 10^6 possibilities, so a bare SHA-256 of it would be trivially reversed by
-- anyone who ever read this table; the keyed MAC is what makes the stored
-- value useless without the server secret.
create table if not exists public.customer_otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- Same E.164 shape enforced on customers.phone (0014), so a challenge can
  -- only ever be raised for a phone in the format find-or-create will use.
  phone       text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),

  -- Hex HMAC-SHA-256. The CHECK makes it structurally impossible to write a
  -- 6-digit plaintext code into this column by mistake.
  code_hash   text not null check (code_hash ~ '^[0-9a-f]{64}$'),

  expires_at  timestamptz not null,
  attempts    integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- The active-challenge lookup: newest un-consumed row for (tenant, phone).
create index if not exists idx_customer_otp_tenant_phone
  on public.customer_otp_challenges(tenant_id, phone, created_at desc);

-- Opportunistic cleanup of dead challenges.
create index if not exists idx_customer_otp_expires
  on public.customer_otp_challenges(expires_at);

alter table public.customer_otp_challenges enable row level security;

-- Pinned to the ONE tenant the subdomain resolved to, like every other public
-- policy (0022/0023). There is deliberately no staff policy: app.user_id alone
-- matches nothing here, so a signed-in staff member's transaction cannot read
-- another customer's challenge either.
drop policy if exists customer_otp_challenges_public_rw on public.customer_otp_challenges;
create policy customer_otp_challenges_public_rw on public.customer_otp_challenges
  for all using (tenant_id = public.current_public_tenant_id())
          with check (tenant_id = public.current_public_tenant_id());

grant select, insert, update, delete on public.customer_otp_challenges to arena_app;

-- ── customer_sessions ───────────────────────────────────────────────────────
-- `id` is the SHA-256 of the opaque random token held in the cookie, mirroring
-- `sessions` (0001): reading this table never yields a usable token.
--
-- The composite FK is the same trick 0016 uses for bookings — (tenant_id,
-- customer_id) must reference a customer that already belongs to that tenant,
-- so a session pointing at another tenant's customer cannot be written at all,
-- not even by the owner connection. Cross-tenant session reuse is therefore a
-- structural impossibility rather than an application-layer check.
create table if not exists public.customer_sessions (
  id          text primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint customer_sessions_customer_tenant_fkey
    foreign key (tenant_id, customer_id)
    references public.customers(tenant_id, id) on delete cascade
);

create index if not exists idx_customer_sessions_customer
  on public.customer_sessions(tenant_id, customer_id);
create index if not exists idx_customer_sessions_expires
  on public.customer_sessions(expires_at);

-- Same posture as public.sessions: the app role can never touch it. There are
-- no policies because there is no grant to apply them to; RLS is enabled so
-- that a future accidental grant still denies by default.
alter table public.customer_sessions enable row level security;
revoke all on public.customer_sessions from arena_app;
