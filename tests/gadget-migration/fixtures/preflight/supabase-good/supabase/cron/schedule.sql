-- in supabase/cron/schedule.sql
-- run with: psql "$DIRECT_DATABASE_URL" -f supabase/cron/schedule.sql
-- one message a night; the worker retries it, which pg_cron never does
select cron.schedule('enqueue-prune-audit-logs', '0 2 * * *', $$ select pgmq.send('scheduled', '{"job": "pruneAuditLogs"}') $$);
-- pg_cron keeps a row per run forever
select cron.schedule('prune-cron-history', '30 3 * * *', $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$);
