-- Troubleshooting reports: what the troubleshooter found, which the person
-- read section by section and chose to send. Written only through
-- tomrade_submit_diagnostic_report; the sender reads (status, the developer's
-- reply) and deletes their own, and the maintainer reads every one with the
-- service role (apps/store-admin).
begin;

create table public.tomrade_diagnostic_reports (
  id uuid primary key default gen_random_uuid(),
  -- What the person quotes when they write about it: R-7K3F2A.
  code text not null unique check (code ~ '^R-[0-9A-Z]{6}$'),
  reporter uuid not null references auth.users(id) on delete cascade,
  -- One failure seen by many people shares one fingerprint.
  fingerprint text not null check (length(fingerprint) <= 80),
  summary text not null default '' check (length(summary) <= 300),
  engine text check (length(engine) <= 64),
  app_version text not null check (length(app_version) <= 40),
  platform text not null check (length(platform) <= 120),
  report jsonb not null check (pg_column_size(report) <= 524288),
  status text not null default 'new' check (status in ('new', 'triaged', 'fixed', 'wontfix', 'duplicate')),
  reply text check (length(reply) <= 4000),
  replied_at timestamptz,
  fixed_in text check (length(fixed_in) <= 40),
  ticket text check (length(ticket) <= 40),
  created_at timestamptz not null default now()
);
create index tomrade_diagnostic_reports_fingerprint on public.tomrade_diagnostic_reports (fingerprint, created_at desc);
create index tomrade_diagnostic_reports_reporter on public.tomrade_diagnostic_reports (reporter, created_at desc);

alter table public.tomrade_diagnostic_reports enable row level security;
revoke all on public.tomrade_diagnostic_reports from anon, authenticated;
grant select, delete on public.tomrade_diagnostic_reports to authenticated;
create policy own_diagnostic_reports on public.tomrade_diagnostic_reports for select to authenticated using (reporter = (select auth.uid()));
create policy delete_own_diagnostic_reports on public.tomrade_diagnostic_reports for delete to authenticated using (reporter = (select auth.uid()));

create function public.tomrade_submit_diagnostic_report(
  p_code text, p_fingerprint text, p_summary text, p_engine text, p_app_version text, p_platform text, p_report jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); recent integer; result uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- An outbox retry after an answer that never arrived lands once.
  select id into result from public.tomrade_diagnostic_reports where code = p_code and reporter = actor;
  if found then return result; end if;
  select count(*) into recent from public.tomrade_diagnostic_reports where reporter = actor and created_at > now() - interval '1 day';
  if recent >= 30 then raise exception 'Too many reports today' using errcode = '54000'; end if;
  insert into public.tomrade_diagnostic_reports(code, reporter, fingerprint, summary, engine, app_version, platform, report)
    values (p_code, actor, p_fingerprint, left(coalesce(p_summary, ''), 300), p_engine, p_app_version, p_platform, p_report)
    returning id into result;
  return result;
end;
$$;

revoke all on function public.tomrade_submit_diagnostic_report(text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.tomrade_submit_diagnostic_report(text, text, text, text, text, text, jsonb) to authenticated;

commit;
