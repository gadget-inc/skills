-- in supabase/migrations/20261109000000_app_server_role.sql
-- no BYPASSRLS and owns no tables, so every policy applies; scripts/set-role-password.ts sets its password
create role app_server with login;
grant usage on schema public to app_server;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to app_server;
alter default privileges for role postgres in schema public grant usage on sequences to app_server;
-- pgvector's types and operators live in the extensions schema
grant usage on schema extensions to app_server;
alter role app_server set search_path = "$user", public, extensions;
-- tables created after this get no Data API grants, whatever the project's default
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
