-- ============================================================================
-- Arena OS — 0075: kitchen-role RLS carve-out for "86" (M17 #7)
--
-- menu_items_write (0010_menu.sql) is manager-only at the RLS level — the
-- right default for editing an item's name/price/image/category. But 86-ing
-- an item (setMenuItemAvailability, lib/actions/menu.ts) is deliberately
-- meant for "any authorised staff" — in practice kitchen staff and up, the
-- same KITCHEN_ROLES gate updateKotStatus already uses on kots
-- (0013_kots.sql). Without this, a kitchen_staff member's toggle passes the
-- app-layer canManageKitchen() check but is then silently dropped by RLS
-- (UPDATE … RETURNING affects 0 rows), which setMenuItemAvailability
-- reports back as "item not found" — the actual bug this migration fixes.
--
-- A second, PERMISSIVE UPDATE policy (Postgres OR's multiple permissive
-- policies for the same command together) rather than loosening
-- menu_items_write itself — kitchen staff still can't touch price, name,
-- image or category, only flip status between available and out_of_stock.
-- Never 'hidden' in either direction, in either the USING (row must not
-- already be hidden) or WITH CHECK (can't flip TO hidden) clause — that
-- stays the stricter, manager-only decision menu_items_write already owns.
-- ============================================================================

drop policy if exists menu_items_86 on public.menu_items;
create policy menu_items_86 on public.menu_items
  for update using (
    tenant_id in (select public.auth_tenant_ids())
    and public.auth_role_in(tenant_id) in ('owner', 'manager', 'kitchen_staff')
    and status in ('available', 'out_of_stock')
  )
  with check (
    tenant_id in (select public.auth_tenant_ids())
    and public.auth_role_in(tenant_id) in ('owner', 'manager', 'kitchen_staff')
    and status in ('available', 'out_of_stock')
  );
