-- in prisma/migrations/20261109000000_lock_session/migration.sql
REVOKE ALL ON "Session" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session" TO app_server;
