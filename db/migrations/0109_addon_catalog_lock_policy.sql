-- M33 fix: lockAddonCatalog() does SELECT ... FOR UPDATE on resource_type_addons
-- from every add-on write path, reachable by cashier/receptionist/floor_staff.
-- Postgres requires the UPDATE policy's USING clause to pass for FOR UPDATE row
-- locking, and resource_type_addons_write is manager-only — so non-manager
-- roles locked 0 rows and every attach failed "no longer available".
-- Permissive policies for one command OR together: USING is widened so any
-- tenant member can take the lock. WITH CHECK stays manager-only (explicit,
-- not left to default to USING) so this does NOT also open real catalog
-- writes to non-managers — FOR UPDATE never evaluates WITH CHECK (it has no
-- new row to validate), only an actual UPDATE...SET does, so locking is
-- unaffected by keeping CHECK narrow. Real catalog mutation stays gated by
-- requireManager() in lib/actions/addons.ts AND, now, by this CHECK too —
-- not application-layer enforcement alone (the manager-only INSERT/DELETE
-- policy above was never affected; this closes the same gap for UPDATE).
drop policy if exists resource_type_addons_lock on public.resource_type_addons;
create policy resource_type_addons_lock on public.resource_type_addons
  for update using (tenant_id in (select public.auth_tenant_ids()))
          with check (public.auth_is_manager(tenant_id));
