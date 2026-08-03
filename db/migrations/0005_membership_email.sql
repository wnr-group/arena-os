-- ============================================================================
-- Arena OS — 0005: denormalise login email onto memberships
--
-- The Team page (owner/manager managing staff) needs to show each member's
-- email. Identity lives in `users`, which the app role deliberately cannot read.
-- Rather than reach across that boundary with the owner connection on a tenant
-- request path, we store the email on the membership row itself, so the Team
-- page stays a pure RLS-scoped read. Kept in sync when memberships are written.
-- ============================================================================

alter table public.memberships add column if not exists email text;

-- Backfill existing rows from the identity table (owner-side, one-time).
update public.memberships m
   set email = u.email
  from public.users u
 where u.id = m.user_id and m.email is null;
