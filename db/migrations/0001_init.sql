-- ============================================================================
-- Arena OS — 0001 init: identity + tenancy tables
-- Runs as the OWNER role (arena_owner), which therefore owns every object.
-- ============================================================================
-- Note: gen_random_uuid() is built into Postgres core since v13, so no
-- pgcrypto extension is required.

-- shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.tenant_status  as enum ('trial','active','suspended','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tenant_industry as enum
    ('gaming_cafe','recording_studio','podcast_studio','dance_studio','vr_centre','other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.branch_status as enum ('active','inactive');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.member_role as enum
    ('owner','manager','cashier','kitchen_staff','floor_staff','receptionist');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.member_status as enum ('invited','active','disabled');
exception when duplicate_object then null; end $$;

-- ── identity (global; NOT tenant-scoped, NOT granted to the app role) ─────────
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  full_name     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_users_updated on public.users;
create trigger trg_users_updated before update on public.users
  for each row execute function public.set_updated_at();

create table if not exists public.sessions (
  id         text primary key,               -- opaque random token, stored in cookie
  user_id    uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on public.sessions(user_id);

-- ── tenants ──────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique
             check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  name       text not null,
  industry   public.tenant_industry not null default 'gaming_cafe',
  status     public.tenant_status   not null default 'trial',
  currency   text not null default 'INR',
  timezone   text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.set_updated_at();

-- ── branches ─────────────────────────────────────────────────────────────────
create table if not exists public.branches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  address    text,
  phone      text,
  timezone   text,
  is_primary boolean not null default false,
  status     public.branch_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists idx_branches_tenant on public.branches(tenant_id);
drop trigger if exists trg_branches_updated on public.branches;
create trigger trg_branches_updated before update on public.branches
  for each row execute function public.set_updated_at();

-- ── memberships (user ↔ tenant + role) ───────────────────────────────────────
create table if not exists public.memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  branch_id  uuid references public.branches(id) on delete set null,
  role       public.member_role   not null default 'cashier',
  status     public.member_status not null default 'active',
  full_name  text,
  phone      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists idx_memberships_user   on public.memberships(user_id);
create index if not exists idx_memberships_tenant on public.memberships(tenant_id);
drop trigger if exists trg_memberships_updated on public.memberships;
create trigger trg_memberships_updated before update on public.memberships
  for each row execute function public.set_updated_at();
