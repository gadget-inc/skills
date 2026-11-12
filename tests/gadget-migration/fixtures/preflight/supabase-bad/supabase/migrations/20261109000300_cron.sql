create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'prune-audit-logs',
  '0 2 * * *',
  $$ select net.http_post(url := 'https://app.example.com/api/cron/prune-audit-logs', body := '{}'::jsonb) $$
);
