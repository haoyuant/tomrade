-- Two more numbers for the dashboard (TOM-999): registered accounts, and how
-- usage splits across macOS, Windows and Linux. Both answer counts only.
begin;

-- Accounts are not anonymous usage: they live in auth.users of the account
-- project, carry no region, and a deleted account is gone from every count.
-- Supabase's anonymous sign-ins, when on, are not registrations.
create function public.tomrade_accounts_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_total integer;
  v_confirmed integer;
  v_new integer;
  v_daily jsonb;
begin
  if p_from is null or p_to is null then
    raise exception 'a report needs two dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the report ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a report covers at most 400 days' using errcode = 'PT400';
  end if;
  v_from := p_from::timestamptz;
  v_to := (p_to + 1)::timestamptz;

  with people as (
    select u.created_at, u.email_confirmed_at
      from auth.users u
     where not coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false)
       and u.deleted_at is null
  )
  select count(*) filter (where created_at < v_to),
         count(*) filter (where created_at < v_to and email_confirmed_at is not null),
         count(*) filter (where created_at >= v_from and created_at < v_to)
    into v_total, v_confirmed, v_new
    from people;

  select coalesce(jsonb_agg(jsonb_build_object('day', t.day, 'new', t.n) order by t.day), '[]'::jsonb)
    into v_daily
    from (select (u.created_at at time zone 'utc')::date as day, count(*) as n
            from auth.users u
           where u.created_at >= v_from and u.created_at < v_to
             and not coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false)
             and u.deleted_at is null
           group by 1) t;

  return jsonb_build_object('total', v_total, 'confirmed', v_confirmed, 'new', v_new, 'daily', v_daily);
end;
$fn$;

-- Active anonymous IDs and active time per platform. Read from the event
-- detail (kept 180 days, longer than any dashboard range); only counts leave.
create function public.tomrade_analytics_platforms(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := p_region;
  v_from timestamptz;
  v_to timestamptz;
  v_platforms jsonb;
begin
  if p_from is null or p_to is null then
    raise exception 'a report needs two dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the report ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a report covers at most 400 days' using errcode = 'PT400';
  end if;
  if v_region = 'all' then v_region := null; end if;
  if v_region is not null and v_region not in ('cn', 'apac', 'eu', 'na', 'other') then
    raise exception 'unknown region %', v_region using errcode = 'PT400';
  end if;
  v_from := p_from::timestamptz;
  v_to := (p_to + 1)::timestamptz;

  select coalesce(jsonb_agg(jsonb_build_object('platform', t.platform, 'aai', t.aai, 'duration_ms', t.duration_ms) order by t.aai desc, t.platform), '[]'::jsonb)
    into v_platforms
    from (select e.platform,
                 count(distinct e.anon_id) as aai,
                 coalesce(sum(e.active_ms) filter (where e.event = 'feature.session'), 0) as duration_ms
            from public.tomrade_analytics_event e
           where e.ts >= v_from and e.ts < v_to and (v_region is null or e.region = v_region)
           group by e.platform) t;

  return jsonb_build_object('platforms', v_platforms);
end;
$fn$;

revoke all on function public.tomrade_accounts_report(date, date) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_platforms(date, date, text) from public, anon, authenticated;
grant execute on function public.tomrade_accounts_report(date, date) to service_role;
grant execute on function public.tomrade_analytics_platforms(date, date, text) to service_role;

commit;
