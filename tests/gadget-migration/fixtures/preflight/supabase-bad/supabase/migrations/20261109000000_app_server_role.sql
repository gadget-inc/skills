create role app_server with login;
grant usage on schema public to app_server;
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to app_server;
alter default privileges for role postgres in schema public grant usage on sequences to app_server;
