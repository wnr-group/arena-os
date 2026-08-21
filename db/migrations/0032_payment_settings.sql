-- ============================================================================
-- Arena OS — 0022 payment_settings: per-tenant Razorpay credentials
--
-- Each business runs its OWN Razorpay account, so the keys are tenant data, not
-- platform config. One row per tenant; `tenant_id` IS the primary key, so a
-- second row for the same tenant is structurally impossible.
--
-- ── The two halves of a Razorpay credential ─────────────────────────────────
--   razorpay_key_id            — PUBLISHABLE. Razorpay Checkout needs it in the
--                                browser. Safe to expose when required.
--   razorpay_key_secret_...    — SECRET. Signs API calls (AROS-49) and verifies
--                                webhook signatures (AROS-50). Encrypted with
--                                AES-256-GCM by lib/security/encryption.ts
--                                before it ever reaches this table, under a
--                                master key held only in the server environment.
--                                It must NEVER reach a browser, plaintext or
--                                ciphertext.
--
-- The column is named `..._encrypted` on purpose: a future reader cannot mistake
-- it for a usable plaintext secret, and the CHECK below makes writing plaintext
-- into it fail rather than succeed quietly.
-- ============================================================================

create table if not exists public.payment_settings (
  tenant_id                     uuid primary key
                                  references public.tenants(id) on delete cascade,
  razorpay_key_id               text,
  razorpay_key_secret_encrypted text,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  -- '' is never a meaningful key id; store NULL for "not configured".
  constraint payment_settings_key_id_shape
    check (razorpay_key_id is null or btrim(razorpay_key_id) <> ''),

  -- THE plaintext guard. encryptSecret() emits `v1:<iv>:<tag>:<ciphertext>`, so
  -- anything that is not versioned AEAD output is rejected by the database
  -- itself — including a raw Razorpay secret written by a future code path that
  -- forgot to encrypt. Defence that does not depend on application discipline.
  constraint payment_settings_secret_is_encrypted
    check (
      razorpay_key_secret_encrypted is null
      or razorpay_key_secret_encrypted ~ '^v[0-9]+:[^:]+:[^:]+:[^:]+$'
    ),

  -- A secret with no key id cannot be used to call Razorpay; refuse the
  -- half-configured state rather than fail confusingly at checkout.
  constraint payment_settings_secret_needs_key_id
    check (razorpay_key_secret_encrypted is null or razorpay_key_id is not null)
);

drop trigger if exists trg_payment_settings_updated on public.payment_settings;
create trigger trg_payment_settings_updated before update on public.payment_settings
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- This table departs from the usual settings template (tax_rates 0013,
-- promo_codes 0017), where every member may SELECT the whole row.
--
-- Here the row CONTAINS the ciphertext, and Postgres RLS is row-level — there is
-- no way to let a cashier read `razorpay_key_id` but not
-- `razorpay_key_secret_encrypted` through the same policy. So the raw row is
-- manager-only, and the two things other members legitimately need are exposed
-- through narrow SECURITY DEFINER functions below — the same device
-- consume_promo_use() uses in 0017.
alter table public.payment_settings enable row level security;

drop policy if exists payment_settings_select on public.payment_settings;
create policy payment_settings_select on public.payment_settings
  for select using (public.auth_is_manager(tenant_id));

drop policy if exists payment_settings_write on public.payment_settings;
create policy payment_settings_write on public.payment_settings
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.payment_settings to arena_app;

-- ── narrow reads for non-manager members ─────────────────────────────────────
-- SECURITY DEFINER (owner) so these are exempt from payment_settings_select,
-- exactly like auth_tenant_ids() in 0002 — and, like it, they cannot leak,
-- because each filters on the CALLER's own tenants. Passing another tenant's id
-- matches no row and returns NULL.

-- The PUBLISHABLE half. Any member may read it; Razorpay Checkout needs it in
-- the browser. This function structurally cannot return the secret.
create or replace function public.payment_key_id(p_tenant uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select razorpay_key_id
    from public.payment_settings
   where tenant_id = p_tenant
     and p_tenant in (select public.auth_tenant_ids());
$$;

-- The CIPHERTEXT half, for the server-only credential loader
-- (lib/settings/razorpay-credentials.ts). A cashier taking an online deposit at
-- the POS must be able to create a Razorpay order, and that runs under their
-- session — hence a member-level hole rather than a manager-only one.
--
-- What comes back is still ciphertext: inert without
-- PAYMENT_SETTINGS_ENCRYPTION_KEY, which lives only in the server environment
-- and never in this database. Nothing here ever returns plaintext.
create or replace function public.payment_secret_ciphertext(p_tenant uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select razorpay_key_secret_encrypted
    from public.payment_settings
   where tenant_id = p_tenant
     and p_tenant in (select public.auth_tenant_ids());
$$;

grant execute on function public.payment_key_id(uuid)            to arena_app;
grant execute on function public.payment_secret_ciphertext(uuid) to arena_app;
