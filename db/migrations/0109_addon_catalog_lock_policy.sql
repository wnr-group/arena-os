-- M33 fix: lockAddonCatalog() does SELECT ... FOR UPDATE on resource_type_addons
-- from every add-on write path, reachable by cashier/receptionist/floor_staff.
-- Postgres requires the UPDATE policy (USING) to pass for FOR UPDATE row
-- locking, and resource_type_addons_write is manager-only — so non-manager
-- roles locked 0 rows and every attach failed "no longer available".
-- Permissive policies for one command OR together: let any tenant member take
-- the lock. Real catalog mutation stays gated by requireManager() in
-- lib/actions/addons.ts (and the manager-only INSERT/DELETE policy above).
drop policy if exists resource_type_addons_lock on public.resource_type_addons;
create policy resource_type_addons_lock on public.resource_type_addons
  for update using (tenant_id in (select public.auth_tenant_ids()));
