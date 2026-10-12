-- Supabase Auth adds a row to auth.audit_log_entries for every sign-in, sign-out,
-- token refresh and password change, with the IP address, and never removes one
-- (its own cleanup covers sessions and tokens, not this table). Keep 90 days: the
-- window the privacy policy states, long enough to look into abuse.
--
-- postgres keeps DELETE on auth tables after Supabase's April 2025 restrictions,
-- and a pg_cron job runs as the role that scheduled it.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- Unschedule by name first, so applying this twice still leaves one job.
select cron.unschedule(jobid) from cron.job where jobname = 'tomrade-auth-audit-retention';
select cron.schedule(
  'tomrade-auth-audit-retention',
  '17 3 * * *',
  $$delete from auth.audit_log_entries where created_at < now() - interval '90 days'$$
);
