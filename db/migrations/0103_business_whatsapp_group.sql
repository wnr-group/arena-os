-- ============================================================================
-- Arena OS — 0103 WhatsApp group invite, per tenant.
--
-- Two columns on `business_profiles` and one narrow public reader. No new
-- table: business_profiles is already the tenant's one-row settings record
-- (tenant_id IS the primary key), it already has an owner-only write policy,
-- and it already has a settings screen. A separate table would have bought a
-- second RLS surface and a second form for two scalars.
--
-- ══ WHY A SECURITY DEFINER FUNCTION AND NOT A PUBLIC POLICY ═════════════════
--
-- The confirmation page (/b/[token]) has no session, so it reads through
-- withPublicTenant(). business_profiles carries the venue's GSTIN, legal name
-- and registered address; RLS is row-level, so a public SELECT policy would
-- expose all of that to anybody who can open a booking link — to hand out a
-- group invite.
--
-- So the invite gets the same treatment public_tenant_by_slug (0022),
-- public_event_teams (0091) and public_event_participants (0099/0101) already
-- get: a SECURITY DEFINER function returning ONE scalar, and the private
-- columns stay closed. This is the established pattern, not a new one.
--
-- ══ TENANT ISOLATION ════════════════════════════════════════════════════════
--
-- The function pins `tenant_id = current_public_tenant_id()` — the GUC
-- withPublicTenant() sets from the subdomain — IN ADDITION to matching the id
-- it is handed. The argument therefore cannot select a row on its own: another
-- venue's tenant id returns null rather than that venue's invite, exactly like
-- a cross-tenant event id returns zero rows from the M15 projections.
--
-- ══ THE TWO CHECKS ═════════════════════════════════════════════════════════
--
-- 1. The URL must be a chat.whatsapp.com invite. This value drives an
--    automatic window.location.href on a public page, so a free-text URL here
--    would be an open redirect with a settings form attached. The regex is the
--    same rule normalizeWhatsappGroupUrl() applies in
--    lib/settings/whatsapp-group.ts — stated in both places for the same
--    reason validateEventFields() mirrors 0088's CHECKs: the application gives
--    a sentence, the database gives the guarantee.
--
--    Note the anchors and the absence of any query: the stored value is always
--    the canonical form, so nothing can ever be appended to it. That is what
--    makes "no customer data reaches WhatsApp" structural.
--
-- 2. `enabled` implies a link. Stated as an implication so "switched on with
--    nothing to point at" is unrepresentable rather than merely guarded
--    against, the same device event_registrations_hold (0091) uses.
--
-- Both columns are additive with safe defaults, so every existing tenant lands
-- disabled with no link and nothing about the booking flow changes.
--
-- ══ WHY 0103 AND NOT 0088, WHICH IS THE NEXT FREE NUMBER HERE ═══════════════
--
-- The gap is deliberate, not a slip. The unmerged M15 events branch already
-- occupies 0088–0102, and scripts/migrate.ts tracks applied files by NAME: two
-- different migrations both called 0088_… would let whichever ran first mark
-- the other as done, silently skipping it. A numbering gap is cosmetic; a
-- filename collision is a corrupted schema. If M15 is dropped rather than
-- merged, renumber this to 0088 before it ships anywhere.
-- ============================================================================

alter table public.business_profiles
  add column if not exists whatsapp_group_url text,
  add column if not exists whatsapp_group_enabled boolean not null default false;

do $$ begin
  alter table public.business_profiles
    add constraint business_profiles_whatsapp_group_url check (
      whatsapp_group_url is null
      or whatsapp_group_url ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9_-]{6,64}$'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.business_profiles
    add constraint business_profiles_whatsapp_group_enabled check (
      not whatsapp_group_enabled or whatsapp_group_url is not null
    );
exception when duplicate_object then null; end $$;

comment on column public.business_profiles.whatsapp_group_url is
  'Canonical WhatsApp group invite (https://chat.whatsapp.com/<code>), or null. Host-pinned by CHECK because it drives an automatic redirect on the public confirmation page (0103).';
comment on column public.business_profiles.whatsapp_group_enabled is
  'Whether the confirmation page offers the WhatsApp group. False for every tenant until an owner turns it on; cannot be true without a link (0103).';

-- ── the public reader ───────────────────────────────────────────────────────
--
-- Returns the invite ONLY when the tenant is the pinned public one, the owner
-- has enabled it, and a link is stored. Every "no" answers null, so the caller
-- has one case to handle and a disabled venue is indistinguishable from one
-- that never configured a link.
create or replace function public.public_whatsapp_group(p_tenant_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select b.whatsapp_group_url
    from public.business_profiles b
   where b.tenant_id = p_tenant_id
     and b.tenant_id = public.current_public_tenant_id()
     and b.whatsapp_group_enabled
     and b.whatsapp_group_url is not null;
$$;

revoke all on function public.public_whatsapp_group(uuid) from public;
grant execute on function public.public_whatsapp_group(uuid) to arena_app;

comment on function public.public_whatsapp_group(uuid) is
  'The tenant''s WhatsApp group invite for the public booking confirmation page (0103). SECURITY DEFINER so the public path never reads business_profiles, which holds the GSTIN, legal name and registered address. Returns one scalar, only for the tenant pinned by withPublicTenant(), and only when the owner has enabled it.';
