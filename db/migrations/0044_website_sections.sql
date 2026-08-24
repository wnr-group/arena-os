-- ============================================================================
-- Arena OS — 0044 website sections: M13 website builder, AROS-A (data model).
--
-- Draft content lives in website_sections/website_settings — plain relational
-- rows the future editor (AROS-C/D) can CRUD and reorder freely. Publishing
-- (AROS-E) is one atomic write of a frozen snapshot into website_pages; the
-- public homepage (TenantHome) only ever reads that snapshot, never the draft
-- tables, so a half-edited draft can never leak to a customer.
-- ============================================================================

do $$ begin
  create type public.website_section_type as enum ('text','image','image_text','video','video_text');
exception when duplicate_object then null; end $$;

create table if not exists public.website_sections (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  type       public.website_section_type not null,
  heading    text,
  content    jsonb not null default '{}',
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_website_sections_tenant on public.website_sections(tenant_id, position);
drop trigger if exists trg_website_sections_updated on public.website_sections;
create trigger trg_website_sections_updated before update on public.website_sections
  for each row execute function public.set_updated_at();

create table if not exists public.website_settings (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  logo_url       text,
  accent_color   text,
  hero_image_url text,
  updated_at     timestamptz not null default now()
);
drop trigger if exists trg_website_settings_updated on public.website_settings;
create trigger trg_website_settings_updated before update on public.website_settings
  for each row execute function public.set_updated_at();

-- published_snapshot is null until the first publish (AROS-E); shape is
-- { sections: [...], settings: {...} }, validated app-side by
-- lib/website/types.ts on every read — never trusted blindly.
create table if not exists public.website_pages (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  published_snapshot jsonb,
  published_at       timestamptz
);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.website_sections enable row level security;
alter table public.website_settings enable row level security;
alter table public.website_pages    enable row level security;

create policy website_sections_select on public.website_sections
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy website_sections_write on public.website_sections
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

create policy website_settings_select on public.website_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy website_settings_write on public.website_settings
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

create policy website_pages_select on public.website_pages
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy website_pages_write on public.website_pages
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Public homepage read (0022_public_booking.sql's current_public_tenant_id()):
-- the only row of any of these three tables a stranger can ever see.
create policy website_pages_public_select on public.website_pages
  for select using (tenant_id = public.current_public_tenant_id());

grant select, insert, update, delete on public.website_sections to arena_app;
grant select, insert, update, delete on public.website_settings to arena_app;
grant select, insert, update, delete on public.website_pages    to arena_app;
