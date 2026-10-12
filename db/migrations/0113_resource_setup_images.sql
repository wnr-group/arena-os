-- ============================================================================
-- Arena OS — 0113: setup photos (M35 #7)
--
-- Up to 3 photos per studio setup (resource_setups, 0099). The cap lives in
-- the database, not just the UI/action: position is CHECKed to 1..3 and
-- UNIQUE per setup, so a fourth image — or two concurrent uploads racing for
-- the same slot — physically cannot be inserted. Position 1 is the cover
-- image used on storefront cards.
--
-- url is the full public URL, same convention as resource_types.image_url
-- (the storage object key is re-derived from it by objectKeyFromUrl() when
-- an image is deleted).
-- ============================================================================

create table if not exists public.resource_setup_images (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  setup_id   uuid not null references public.resource_setups(id) on delete cascade,
  url        text not null,
  position   smallint not null check (position between 1 and 3),
  created_at timestamptz not null default now(),
  constraint resource_setup_images_setup_position_key unique (setup_id, position)
);
create index if not exists idx_resource_setup_images_tenant on public.resource_setup_images(tenant_id);

comment on table public.resource_setup_images is
  'M35 #7 — up to 3 photos per resource_setups row. position 1..3 (CHECK) + UNIQUE (setup_id, position) enforce the cap in the database. Position 1 is the card cover.';

-- ============================================================================
-- RLS + grants
-- ============================================================================
alter table public.resource_setup_images enable row level security;

-- Any active member reads.
drop policy if exists resource_setup_images_select on public.resource_setup_images;
create policy resource_setup_images_select on public.resource_setup_images
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Owner/manager writes. WITH CHECK is spelled out on purpose (AROS-294): a
-- policy without it silently reuses USING, and widening USING later would then
-- open writes without anyone noticing.
drop policy if exists resource_setup_images_write on public.resource_setup_images;
create policy resource_setup_images_write on public.resource_setup_images
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Public (anonymous storefront) read: only the resolved tenant's images, and
-- only while the PARENT setup is active — images have no is_active of their
-- own, so without the parent check deactivating a setup would still leak its
-- photos through a direct query.
drop policy if exists resource_setup_images_public_select on public.resource_setup_images;
create policy resource_setup_images_public_select on public.resource_setup_images
  for select using (
    tenant_id = public.current_public_tenant_id()
    and exists (
      select 1 from public.resource_setups s
       where s.id = resource_setup_images.setup_id
         and s.tenant_id = resource_setup_images.tenant_id
         and s.is_active = true
    )
  );

grant select, insert, update, delete on public.resource_setup_images to arena_app;
