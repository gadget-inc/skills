-- Checks a Postgres connection the way your app will use it. Run it with the exact URL and role
-- the app connects with, not the admin URL:
--   psql "$DATABASE_URL" -f scripts/db-check.sql
-- Each row is ok, problem, or info. references/platforms/common.md explains each check.
\set ON_ERROR_STOP on
\pset footer off
\echo
\echo 'db-check: one row per check, run as the role your app connects with'

select check_name as "check", status, detail
from (
  -- Postgres skips row-level security for superusers and roles with BYPASSRLS
  select 1 as ord, 'role bypasses row-level security' as check_name,
    case when rolsuper or rolbypassrls then 'problem' else 'ok' end as status,
    format('connected as %s (superuser: %s, bypassrls: %s)', rolname, rolsuper, rolbypassrls) as detail
  from pg_roles where rolname = current_user

  union all
  -- the owner of a table skips its policies unless the table forces row-level security
  select 2, 'owns tables with row-level security',
    case when count(*) > 0 then 'problem' else 'ok' end,
    case when count(*) > 0
      then format('%s skips the policies on %s table(s) it owns: %s. Connect as a role that does not own the tables, or run alter table ... force row level security',
        current_user, count(*), string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname))
      else 'no table with row-level security is owned by this role without force row level security' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and c.relrowsecurity and not c.relforcerowsecurity
    and pg_get_userbyid(c.relowner) = current_user
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'

  union all
  -- row-level security with no policy for this role returns no rows, without an error
  select 3, 'tables with no policy for this role',
    case when count(*) > 0 then 'problem' else 'ok' end,
    case when count(*) > 0
      then format('row-level security is on and no policy applies to %s, so reads return 0 rows: %s',
        current_user, string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname))
      else 'every readable table with row-level security has a policy for this role' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and c.relrowsecurity
    and has_table_privilege(c.oid, 'select')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
    and not exists (
      select 1 from pg_policy p
      where p.polrelid = c.oid
        and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) r where pg_has_role(current_user, r, 'member')))
    )
    -- a role that skips row-level security sees every row anyway, which check 1 reports
    and not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls))
    and pg_get_userbyid(c.relowner) <> current_user

  union all
  -- tables this role can read with row-level security off, next to tables that have it on
  select 4, 'readable tables without row-level security',
    case when count(*) > 0 and exists (select 1 from pg_class where relrowsecurity) then 'info' else 'ok' end,
    case when count(*) > 0
      then format('%s table(s) have row-level security off: %s', count(*),
        string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname))
      else 'none' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and not c.relrowsecurity
    and has_table_privilege(c.oid, 'select')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
    and n.nspname not in ('auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations', 'cron', 'net', 'pgmq', 'vault', 'graphql', 'graphql_public', 'extensions', '_prisma_migrations')
    and c.relname <> '_prisma_migrations'

  union all
  -- pgvector installed in a schema this role can't use or doesn't search, as on Supabase
  select 5, 'pgvector reachable',
    case
      when e.oid is null then 'ok'
      when not has_schema_privilege(e.extnamespace, 'usage') then 'problem'
      when to_regtype('vector') is null then 'problem'
      else 'ok' end,
    case
      when e.oid is null then 'vector extension not installed'
      when not has_schema_privilege(e.extnamespace, 'usage')
        then format('vector is in schema %s, and %s has no usage on it: grant usage on schema %s to %s', e.extnamespace::regnamespace, current_user, e.extnamespace::regnamespace, current_user)
      when to_regtype('vector') is null
        then format('vector is in schema %s, which is not on search_path (%s), so <=> fails with operator does not exist: alter role %s set search_path = "$user", public, %s',
          e.extnamespace::regnamespace, current_setting('search_path'), current_user, e.extnamespace::regnamespace)
      else format('vector %s in schema %s', e.extversion, e.extnamespace::regnamespace) end
  from (select 1) one left join pg_extension e on e.extname = 'vector'

  union all
  -- a pooler or proxy listens on another port than Postgres itself
  select 6, 'port',
    'info',
    case
      when inet_server_port() is null then 'connected over a Unix socket'
      when inet_server_port()::text = :'PORT' then format('connected straight to Postgres on port %s', :'PORT')
      else format('connected on port %s, and Postgres listens on %s: a pooler, proxy, or port mapping is in between. Run the load script and migrations over the direct URL', :'PORT', inet_server_port()) end

  union all
  select 7, 'connections',
    'info',
    format('max_connections %s, %s reserved for superusers, %s in use now, server %s',
      current_setting('max_connections'), current_setting('superuser_reserved_connections'),
      (select count(*) from pg_stat_activity), current_setting('server_version'))
) checks
order by ord;
