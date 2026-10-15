-- Feedback and ideas go the way troubleshooting reports go, marked by kind.
-- The people who triage them do it from Tomrade's own inbox, signed in as
-- themselves: tomrade_maintainers names them (written only with the service
-- role, by apps/store-admin), and the two functions at the bottom are the only
-- way their app reads every report and answers one. A sender's identity never
-- leaves the table; the inbox sees the report's code.
begin;

alter table public.tomrade_diagnostic_reports
  add column kind text not null default 'bug' check (kind in ('bug', 'feedback', 'idea'));
create index tomrade_diagnostic_reports_created on public.tomrade_diagnostic_reports (created_at);

create table public.tomrade_maintainers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.tomrade_maintainers enable row level security;
revoke all on public.tomrade_maintainers from anon, authenticated;

-- Same name, one more argument with a default: an app from before kinds still sends.
drop function public.tomrade_submit_diagnostic_report(text, text, text, text, text, text, jsonb);
create function public.tomrade_submit_diagnostic_report(
  p_code text, p_fingerprint text, p_summary text, p_engine text, p_app_version text, p_platform text, p_report jsonb, p_kind text default 'bug'
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
  insert into public.tomrade_diagnostic_reports(code, reporter, kind, fingerprint, summary, engine, app_version, platform, report)
    values (p_code, actor, coalesce(p_kind, 'bug'), p_fingerprint, left(coalesce(p_summary, ''), 300), p_engine, p_app_version, p_platform, p_report)
    returning id into result;
  return result;
end;
$$;

revoke all on function public.tomrade_submit_diagnostic_report(text, text, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.tomrade_submit_diagnostic_report(text, text, text, text, text, text, jsonb, text) to authenticated;

create function public.tomrade_is_maintainer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tomrade_maintainers where user_id = (select auth.uid()))
$$;

-- Reports received at or after p_since, oldest first; the inbox keeps one entry per code.
create function public.tomrade_feedback_pull(p_since timestamptz default null, p_limit integer default 200)
returns table (code text, kind text, summary text, engine text, app_version text, platform text, report jsonb, status text, ticket text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.tomrade_is_maintainer() then raise exception 'Not a maintainer' using errcode = '42501'; end if;
  return query
    select r.code, r.kind, r.summary, r.engine, r.app_version, r.platform, r.report, r.status, r.ticket, r.created_at
    from public.tomrade_diagnostic_reports r
    where p_since is null or r.created_at >= p_since
    order by r.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

-- A triage or a reply, as the sender then reads it under My reports. Null leaves a column as it is.
create function public.tomrade_feedback_answer(p_code text, p_status text default null, p_reply text default null, p_ticket text default null, p_fixed_in text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tomrade_is_maintainer() then raise exception 'Not a maintainer' using errcode = '42501'; end if;
  update public.tomrade_diagnostic_reports set
    status = coalesce(p_status, status),
    reply = coalesce(p_reply, reply),
    replied_at = case when p_reply is null then replied_at else now() end,
    ticket = coalesce(p_ticket, ticket),
    fixed_in = coalesce(p_fixed_in, fixed_in)
  where code = p_code;
  if not found then raise exception 'No report %', p_code using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.tomrade_is_maintainer(), public.tomrade_feedback_pull(timestamptz, integer), public.tomrade_feedback_answer(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tomrade_is_maintainer(), public.tomrade_feedback_pull(timestamptz, integer), public.tomrade_feedback_answer(text, text, text, text, text) to authenticated;

commit;
