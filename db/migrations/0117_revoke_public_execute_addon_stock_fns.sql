-- ============================================================================
-- Arena OS — 0117: close the default PUBLIC EXECUTE grant on the add-on stock
-- SECURITY DEFINER functions (0110, 0112).
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so the explicit
-- `grant ... to arena_app` in those migrations restricted nothing. Both bodies
-- already fail closed on tenant scope; this removes the surface anyway. arena_app
-- keeps its explicit grant (re-stated here so the migration is self-contained);
-- the owner role keeps execute as the function owner.
-- ============================================================================

revoke execute on function public.public_addon_reserved_units(uuid[], timestamptz, timestamptz) from public;
revoke execute on function public.addon_reserved_units(uuid, uuid, timestamptz, timestamptz, uuid) from public;

grant execute on function public.public_addon_reserved_units(uuid[], timestamptz, timestamptz) to arena_app;
grant execute on function public.addon_reserved_units(uuid, uuid, timestamptz, timestamptz, uuid) to arena_app;
