-- ============================================================================
-- Arena OS — 0004 platform admin
--
-- The platform operator (Arena OS itself) sits ABOVE tenants: they create and
-- manage companies and provision each company's first owner. That is a distinct,
-- higher trust tier than any tenant role, so we mark it on the global users row.
-- Platform-admin operations are inherently cross-tenant and run via the OWNER
-- connection, gated in the app by this flag — never exposed to the arena_app role.
-- ============================================================================

alter table public.users
  add column if not exists is_platform_admin boolean not null default false;

-- (users is never granted to arena_app, so this flag is invisible to tenant
-- queries — a tenant can neither read nor set platform-admin status.)
