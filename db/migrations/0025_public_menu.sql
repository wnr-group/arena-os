-- ============================================================================
-- Arena OS — 0025 public menu: read-only access to the food menu for
-- un-authenticated visitors on a tenant subdomain (the public homepage's
-- Menu section). Same app.public_tenant_id pinning as 0022_public_booking.sql;
-- only active categories and available items are ever visible.
-- ============================================================================

drop policy if exists menu_categories_public_select on public.menu_categories;
create policy menu_categories_public_select on public.menu_categories
  for select using (
    tenant_id = public.current_public_tenant_id() and is_active = true
  );

drop policy if exists menu_items_public_select on public.menu_items;
create policy menu_items_public_select on public.menu_items
  for select using (
    tenant_id = public.current_public_tenant_id() and status = 'available'
  );
