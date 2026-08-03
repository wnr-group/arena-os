-- ============================================================================
-- Arena OS — one-time bootstrap. Run ONCE as a superuser, connected to the
-- arena_os database:
--
--   createdb arena_os              # or: psql -c "create database arena_os"
--   psql -d arena_os -f db/bootstrap.sql
--
-- Creates the two roles the isolation model depends on and hands schema
-- ownership to arena_owner (so migrations it runs own the tables and are thus
-- RLS-exempt, while arena_app is not). Change the passwords and mirror them in
-- .env.local (DATABASE_URL / DATABASE_URL_OWNER).
-- ============================================================================

do $$ begin
  if not exists (select from pg_roles where rolname = 'arena_owner') then
    create role arena_owner login password 'arena_owner_pw';
  end if;
  if not exists (select from pg_roles where rolname = 'arena_app') then
    create role arena_app login password 'arena_app_pw';
  end if;
end $$;

-- Hand the database + schema to arena_owner so migrations it runs own every
-- object (and can create extensions later if ever needed).
alter database arena_os owner to arena_owner;
alter schema public owner to arena_owner;
grant usage on schema public to arena_app;
