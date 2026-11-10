create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- jobs are scheduled per environment at the cutover by supabase/cron/schedule.sql
