-- The maintainer's own installs, told apart (TOM-1062).
--
-- An anonymous id is internal once it has sent any event from a build that is
-- not a release: a version with a prerelease tag or build metadata (`0.26.0-dev`,
-- `0.29.0+internal`, which TOMRADE_ANALYTICS_INTERNAL=1 makes a release build
-- report) or `0.1.0`, the version of an unpackaged checkout. It counts from its
-- first event on, also back in time: every day it was active is internal.
--
-- A trigger beside ingest (ingest itself is unchanged) records the id the
-- moment such an event lands. The feature and action rollups carry no id, so
-- they gain an `internal` key column; the aggregate step splits by it and, for
-- an id newly marked, rebuilds every earlier day that id has detail for, so
-- its older rows move to the internal side too. The actor rollup and raw
-- events keep the id and are filtered by the list directly. Every dashboard
-- RPC takes `p_exclude_internal` (default false, the old numbers).
--
-- Run after 202611110102: activation below carries TOM-1060's start step.
begin;

create function public.tomrade_analytics_internal_client(p_client text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_client ~ '[-+]' or p_client = '0.1.0';
$fn$;

-- `rolled` is false until aggregation has rebuilt the id's earlier days.
create table public.tomrade_analytics_internal (
  anon_id text primary key,
  since timestamptz not null,
  rolled boolean not null default false
);
alter table public.tomrade_analytics_internal enable row level security;
revoke all on public.tomrade_analytics_internal from public, anon, authenticated;

create function public.tomrade_analytics_mark_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.tomrade_analytics_internal (anon_id, since) values (new.anon_id, new.ts)
  on conflict (anon_id) do update set since = excluded.since
   where excluded.since < public.tomrade_analytics_internal.since;
  return null;
end;
$fn$;

create trigger tomrade_analytics_event_internal
  after insert on public.tomrade_analytics_event
  for each row when (public.tomrade_analytics_internal_client(new.client))
  execute function public.tomrade_analytics_mark_internal();

revoke all on function public.tomrade_analytics_internal_client(text) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_mark_internal() from public, anon, authenticated;

alter table public.tomrade_analytics_feature_daily
  add column internal boolean not null default false,
  drop constraint tomrade_analytics_feature_daily_pkey,
  add primary key (day, region, feature_id, client_minor, internal);
alter table public.tomrade_analytics_action_daily
  add column internal boolean not null default false,
  drop constraint tomrade_analytics_action_daily_pkey,
  add primary key (day, region, feature_id, action, dim, client_minor, internal);

-- The former aggregate, for one range, split by internal.
create function public.tomrade_analytics_rollup(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_from timestamptz := p_from::timestamptz;
  v_to timestamptz := (p_to + 1)::timestamptz;
  v_actors integer := 0;
  v_star integer := 0;
  v_features integer := 0;
  v_actions integer := 0;
begin
  delete from public.tomrade_analytics_actor_daily where day between p_from and p_to;
  delete from public.tomrade_analytics_feature_daily where day between p_from and p_to;
  delete from public.tomrade_analytics_action_daily where day between p_from and p_to;

  insert into public.tomrade_analytics_actor_daily (day, region, feature_id, anon_id)
  select distinct (e.ts at time zone 'utc')::date, e.region, e.feature_id, e.anon_id
    from public.tomrade_analytics_event e
   where e.ts >= v_from and e.ts < v_to and e.feature_id is not null
  on conflict do nothing;
  get diagnostics v_actors = row_count;

  insert into public.tomrade_analytics_actor_daily (day, region, feature_id, anon_id)
  select distinct (e.ts at time zone 'utc')::date, e.region, '*', e.anon_id
    from public.tomrade_analytics_event e
   where e.ts >= v_from and e.ts < v_to
  on conflict do nothing;
  get diagnostics v_star = row_count;

  insert into public.tomrade_analytics_feature_daily (day, region, feature_id, client_minor, internal, sessions, active_ms, actors)
  select (e.ts at time zone 'utc')::date,
         e.region,
         e.feature_id,
         split_part(e.client, '.', 1) || '.' || split_part(e.client, '.', 2),
         i.anon_id is not null,
         count(*) filter (where e.event = 'feature.session'),
         coalesce(sum(e.active_ms) filter (where e.event = 'feature.session'), 0),
         count(distinct e.anon_id)
    from public.tomrade_analytics_event e
    left join public.tomrade_analytics_internal i on i.anon_id = e.anon_id
   where e.ts >= v_from and e.ts < v_to and e.feature_id is not null
   group by 1, 2, 3, 4, 5;
  get diagnostics v_features = row_count;

  insert into public.tomrade_analytics_action_daily (day, region, feature_id, action, dim, client_minor, internal, events, counted_events, actors)
  select (e.ts at time zone 'utc')::date,
         e.region,
         e.feature_id,
         e.action,
         coalesce(e.dim, ''),
         split_part(e.client, '.', 1) || '.' || split_part(e.client, '.', 2),
         i.anon_id is not null,
         count(*),
         count(*) filter (where e.counted),
         count(distinct e.anon_id)
    from public.tomrade_analytics_event e
    left join public.tomrade_analytics_internal i on i.anon_id = e.anon_id
   where e.event = 'feature.activate' and e.ts >= v_from and e.ts < v_to
   group by 1, 2, 3, 4, 5, 6, 7;
  get diagnostics v_actions = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'actors', v_actors + v_star, 'features', v_features, 'actions', v_actions);
end;
$fn$;

revoke all on function public.tomrade_analytics_rollup(date, date) from public, anon, authenticated;

-- First the days outside the range that newly marked ids were active on, then
-- the range. Those days still have their detail: a partition goes whole.
create or replace function public.tomrade_analytics_aggregate(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ids text[];
  v_day date;
  v_resplit integer := 0;
  v_result jsonb;
begin
  if p_from is null or p_to is null then
    raise exception 'a range needs two dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the range ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a range covers at most 400 days' using errcode = 'PT400';
  end if;

  v_ids := array(select anon_id from public.tomrade_analytics_internal where not rolled);
  if cardinality(v_ids) > 0 then
    for v_day in
      select distinct (e.ts at time zone 'utc')::date
        from public.tomrade_analytics_event e
       where e.anon_id = any (v_ids)
         and (e.ts at time zone 'utc')::date not between p_from and p_to
    loop
      perform public.tomrade_analytics_rollup(v_day, v_day);
      v_resplit := v_resplit + 1;
    end loop;
  end if;

  v_result := public.tomrade_analytics_rollup(p_from, p_to);
  update public.tomrade_analytics_internal set rolled = true where anon_id = any (v_ids);
  return v_result || jsonb_build_object('resplit_days', v_resplit);
end;
$fn$;

revoke all on function public.tomrade_analytics_aggregate(date, date) from public, anon, authenticated;

-- A new parameter means a new signature: the old one goes, so PostgREST's
-- named arguments resolve to exactly one function.
drop function public.tomrade_analytics_report(date, date, text);
drop function public.tomrade_analytics_feature_days(date, date, text);
drop function public.tomrade_analytics_activation(date, date, text);
drop function public.tomrade_analytics_platforms(date, date, text);

create function public.tomrade_analytics_report(p_from date, p_to date, p_region text default null, p_exclude_internal boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := nullif(p_region, '');
  v_all boolean := not coalesce(p_exclude_internal, false);
  v_internal text[] := case when coalesce(p_exclude_internal, false) then array(select anon_id from public.tomrade_analytics_internal) else '{}'::text[] end;
  v_from timestamptz := p_from::timestamptz;
  v_to timestamptz := (p_to + 1)::timestamptz;
  v_daily jsonb := '[]'::jsonb;
  v_features jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_retention jsonb := '[]'::jsonb;
  v_regions jsonb := '[]'::jsonb;
  v_totals jsonb;
  v_latest timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'the range is not a range' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a report covers at most 400 days' using errcode = 'PT400';
  end if;
  if v_region = 'all' then v_region := null; end if;
  if v_region is not null and v_region not in ('cn', 'apac', 'eu', 'na', 'other') then
    raise exception 'unknown region %', v_region using errcode = 'PT400';
  end if;

  select jsonb_build_object(
    'duration_ms', coalesce((select sum(active_ms) from public.tomrade_analytics_feature_daily
                              where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)), 0),
    'sessions', coalesce((select sum(sessions) from public.tomrade_analytics_feature_daily
                           where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)), 0),
    'uses', coalesce((select sum(counted_events) from public.tomrade_analytics_action_daily
                       where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)), 0),
    'aai', coalesce((select count(distinct anon_id) from public.tomrade_analytics_actor_daily
                      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)), 0)
  ) into v_totals;

  with days as (
    select day from public.tomrade_analytics_feature_daily
      where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
    union
    select day from public.tomrade_analytics_action_daily
      where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
    union
    select day from public.tomrade_analytics_actor_daily
      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day,
           'duration_ms', coalesce(f.duration, 0),
           'sessions', coalesce(f.sessions, 0),
           'uses', coalesce(a.uses, 0),
           'aai', coalesce(u.aai, 0)
         ) order by d.day), '[]'::jsonb)
    into v_daily
    from days d
    left join (select day, sum(active_ms) as duration, sum(sessions) as sessions
                 from public.tomrade_analytics_feature_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by day) f on f.day = d.day
    left join (select day, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by day) a on a.day = d.day
    left join (select day, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)
                group by day) u on u.day = d.day;

  with known as (
    select distinct feature_id from public.tomrade_analytics_registry
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'feature_id', k.feature_id,
           'sessions', coalesce(f.sessions, 0),
           'duration_ms', coalesce(f.duration, 0),
           'uses', coalesce(a.uses, 0),
           'aai', coalesce(u.aai, 0)
         ) order by coalesce(f.duration, 0) desc, k.feature_id), '[]'::jsonb)
    into v_features
    from known k
    left join (select feature_id, sum(sessions) as sessions, sum(active_ms) as duration
                 from public.tomrade_analytics_feature_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by feature_id) f on f.feature_id = k.feature_id
    left join (select feature_id, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by feature_id) a on a.feature_id = k.feature_id
    left join (select feature_id, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id <> '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)
                group by feature_id) u on u.feature_id = k.feature_id
   where coalesce(f.sessions, 0) + coalesce(f.duration, 0) + coalesce(a.uses, 0) + coalesce(u.aai, 0) > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
           'feature_id', t.feature_id,
           'action', t.action,
           'events', t.events,
           'counted_events', t.counted_events
         ) order by t.counted_events desc, t.feature_id, t.action), '[]'::jsonb)
    into v_actions
    from (select feature_id, action, sum(events) as events, sum(counted_events) as counted_events
            from public.tomrade_analytics_action_daily
           where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
           group by feature_id, action) t;

  with scoped as (
    select anon_id, day from public.tomrade_analytics_actor_daily
     where feature_id = '*' and day between p_from and p_to + 30
       and (v_region is null or region = v_region) and anon_id <> all (v_internal)
  ), cohort as (
    select anon_id, min(day) as day from scoped
     where day between p_from and p_to
     group by anon_id
  ), flags as (
    select c.day,
      exists (select 1 from scoped s where s.anon_id = c.anon_id and s.day = c.day + 1) as d1,
      exists (select 1 from scoped s where s.anon_id = c.anon_id and s.day = c.day + 7) as d7,
      exists (select 1 from scoped s where s.anon_id = c.anon_id and s.day = c.day + 30) as d30
      from cohort c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', t.day, 'cohort', t.cohort,
           'd1', t.d1, 'd7', t.d7, 'd30', t.d30
         ) order by t.day), '[]'::jsonb)
    into v_retention
    from (select day, count(*) as cohort,
                 count(*) filter (where d1) as d1,
                 count(*) filter (where d7) as d7,
                 count(*) filter (where d30) as d30
            from flags group by day) t;

  with regions as (
    select region from public.tomrade_analytics_feature_daily
      where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
    union
    select region from public.tomrade_analytics_action_daily
      where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
    union
    select region from public.tomrade_analytics_actor_daily
      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'region', r.region,
           'duration_ms', coalesce(f.duration, 0),
           'sessions', coalesce(f.sessions, 0),
           'uses', coalesce(a.uses, 0),
           'aai', coalesce(u.aai, 0)
         ) order by coalesce(f.duration, 0) desc, r.region), '[]'::jsonb)
    into v_regions
    from regions r
    left join (select region, sum(active_ms) as duration, sum(sessions) as sessions
                 from public.tomrade_analytics_feature_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by region) f on f.region = r.region
    left join (select region, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region) and (v_all or not internal)
                group by region) a on a.region = r.region
    left join (select region, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region) and anon_id <> all (v_internal)
                group by region) u on u.region = r.region;

  select max(received_at) into v_latest
    from public.tomrade_analytics_event
   where ts >= v_from and ts < v_to and anon_id <> all (v_internal);

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'region', v_region,
    'latest', v_latest,
    'totals', v_totals,
    'daily', v_daily,
    'features', v_features,
    'regions', v_regions,
    'actions', v_actions,
    'retention', v_retention
  );
end;
$fn$;

create function public.tomrade_analytics_feature_days(p_from date, p_to date, p_region text default null, p_exclude_internal boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := nullif(p_region, '');
  v_all boolean := not coalesce(p_exclude_internal, false);
  v_days jsonb := '[]'::jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'the range is not a range' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a series covers at most 400 days' using errcode = 'PT400';
  end if;
  if v_region = 'all' then v_region := null; end if;
  if v_region is not null and v_region not in ('cn', 'apac', 'eu', 'na', 'other') then
    raise exception 'unknown region %', v_region using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day,
           'region', d.region,
           'feature_id', d.feature_id,
           'duration_ms', d.duration_ms,
           'sessions', d.sessions,
           'uses', d.uses
         ) order by d.day, d.feature_id, d.region), '[]'::jsonb)
    into v_days
    from (
      select f.day,
             f.region,
             f.feature_id,
             sum(f.active_ms) as duration_ms,
             sum(f.sessions) as sessions,
             coalesce(max(a.uses), 0) as uses
        from public.tomrade_analytics_feature_daily f
        left join (select day, region, feature_id, sum(counted_events) as uses
                     from public.tomrade_analytics_action_daily
                    where day between p_from and p_to and (v_all or not internal)
                    group by day, region, feature_id) a
          on a.day = f.day and a.region = f.region and a.feature_id = f.feature_id
       where f.day between p_from and p_to and (v_region is null or f.region = v_region) and (v_all or not f.internal)
       group by f.day, f.region, f.feature_id
    ) d;

  return jsonb_build_object('from', p_from, 'to', p_to, 'region', v_region, 'days', v_days);
end;
$fn$;

-- As in 202611110102 (TOM-1060), the start step is the first code.link start
-- or claim_external, whichever comes first; the rest is 202610290001's.
create function public.tomrade_analytics_activation(p_from date, p_to date, p_region text default null, p_exclude_internal boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := nullif(p_region, '');
  v_internal text[] := case when coalesce(p_exclude_internal, false) then array(select anon_id from public.tomrade_analytics_internal) else '{}'::text[] end;
  v_from timestamptz := p_from::timestamptz;
  v_to timestamptz := (p_to + 1)::timestamptz;
  v_today date := (now() at time zone 'utc')::date;
  v_result jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'the range is not a range' using errcode = 'PT400';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a funnel covers at most 400 days' using errcode = 'PT400';
  end if;
  if v_region = 'all' then v_region := null; end if;
  if v_region is not null and v_region not in ('cn', 'apac', 'eu', 'na', 'other') then
    raise exception 'unknown region %', v_region using errcode = 'PT400';
  end if;

  with scoped as (
    select e.anon_id, e.ts, e.event, e.feature_id, e.action
      from public.tomrade_analytics_event e
     where (v_region is null or e.region = v_region) and e.anon_id <> all (v_internal)
  ), installs as (
    select anon_id, min(ts) as installed
      from scoped
     group by anon_id
    having min(ts) >= v_from and min(ts) < v_to
  ), firsts as (
    select i.anon_id,
           i.installed,
           (i.installed at time zone 'utc')::date as day,
           min(s.ts) filter (where s.event = 'feature.activate' and s.feature_id = 'onboarding' and s.action = 'setup_done') as setup_at,
           min(s.ts) filter (where s.event = 'feature.activate' and s.feature_id = 'code.link' and s.action in ('start', 'claim_external')) as start_at,
           min(s.ts) filter (where s.event = 'feature.activate' and s.feature_id = 'code.link' and s.action = 'open_pr') as pr_at,
           min(s.ts) filter (where s.event = 'feature.activate' and s.feature_id = 'code.link' and s.action = 'merge') as merge_at,
           bool_or((s.ts at time zone 'utc')::date between (i.installed at time zone 'utc')::date + 1
                                                       and (i.installed at time zone 'utc')::date + 7) as returned
      from installs i
      join scoped s on s.anon_id = i.anon_id
     group by i.anon_id, i.installed
  )
  select jsonb_build_object(
           'from', p_from,
           'to', p_to,
           'region', v_region,
           'funnel', jsonb_build_object(
             'installs', count(*),
             'setup_done', count(*) filter (where setup_at is not null),
             'start', count(*) filter (where setup_at is not null and start_at is not null),
             'open_pr', count(*) filter (where setup_at is not null and start_at is not null and pr_at is not null),
             'merge', count(*) filter (where setup_at is not null and start_at is not null and pr_at is not null and merge_at is not null)
           ),
           'first_start', jsonb_build_object(
             'median_ms', round(percentile_cont(0.5) within group (order by extract(epoch from start_at - installed) * 1000)
                                filter (where start_at is not null))::bigint,
             'n', count(*) filter (where start_at is not null)
           ),
           'merged_7d', jsonb_build_object(
             'cohort', count(*) filter (where installed <= now() - interval '7 days'),
             'merged', count(*) filter (where installed <= now() - interval '7 days' and merge_at < installed + interval '7 days')
           ),
           'week_return', jsonb_build_object(
             'cohort', count(*) filter (where day + 7 < v_today),
             'returned', count(*) filter (where day + 7 < v_today and returned)
           )
         )
    into v_result
    from firsts;

  return v_result;
end;
$fn$;

create function public.tomrade_analytics_platforms(p_from date, p_to date, p_region text default null, p_exclude_internal boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := p_region;
  v_internal text[] := case when coalesce(p_exclude_internal, false) then array(select anon_id from public.tomrade_analytics_internal) else '{}'::text[] end;
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
           where e.ts >= v_from and e.ts < v_to and (v_region is null or e.region = v_region) and e.anon_id <> all (v_internal)
           group by e.platform) t;

  return jsonb_build_object('platforms', v_platforms);
end;
$fn$;

revoke all on function public.tomrade_analytics_report(date, date, text, boolean) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_feature_days(date, date, text, boolean) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_activation(date, date, text, boolean) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_platforms(date, date, text, boolean) from public, anon, authenticated;
grant execute on function public.tomrade_analytics_report(date, date, text, boolean) to service_role;
grant execute on function public.tomrade_analytics_feature_days(date, date, text, boolean) to service_role;
grant execute on function public.tomrade_analytics_activation(date, date, text, boolean) to service_role;
grant execute on function public.tomrade_analytics_platforms(date, date, text, boolean) to service_role;

-- The list holds ids, so it is kept no longer than their detail: once an id
-- has no event left, its actor rows are gone and its rollup rows carry the flag.
create or replace function public.tomrade_analytics_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_partition text;
  v_start date;
  v_parts integer := 0;
  v_actors integer := 0;
  v_features integer := 0;
  v_actions integer := 0;
  v_rates integer := 0;
  v_internal integer := 0;
begin
  for v_partition, v_start in
    select c.relname, to_date(replace(substring(c.relname from '([0-9]{4}_[0-9]{2})'), '_', '-') || '-01', 'YYYY-MM-DD')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname ~ '^tomrade_analytics_event_[0-9]{4}_[0-9]{2}$'
  loop
    if v_start + interval '1 month' <= (now() at time zone 'utc')::date - 180 then
      execute format('drop table if exists public.%I', v_partition);
      v_parts := v_parts + 1;
    end if;
  end loop;

  delete from public.tomrade_analytics_actor_daily where day < (now() at time zone 'utc')::date - 180;
  get diagnostics v_actors = row_count;
  delete from public.tomrade_analytics_feature_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_features = row_count;
  delete from public.tomrade_analytics_action_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_actions = row_count;
  delete from public.tomrade_analytics_rate where window_start < now() - interval '2 days';
  get diagnostics v_rates = row_count;
  delete from public.tomrade_analytics_internal i
   where not exists (select 1 from public.tomrade_analytics_event e where e.anon_id = i.anon_id);
  get diagnostics v_internal = row_count;

  return jsonb_build_object('partitions', v_parts, 'actors', v_actors, 'features', v_features, 'actions', v_actions, 'rates', v_rates, 'internal', v_internal);
end;
$fn$;

revoke all on function public.tomrade_analytics_retention() from public, anon, authenticated;

-- Backfill: every id already internal, then one aggregation, which rebuilds
-- the days those ids were active on; days with only release builds stay as
-- they are, already right with internal = false.
insert into public.tomrade_analytics_internal (anon_id, since)
select anon_id, min(ts)
  from public.tomrade_analytics_event
 where public.tomrade_analytics_internal_client(client)
 group by anon_id;

select public.tomrade_analytics_aggregate((now() at time zone 'utc')::date - 2, (now() at time zone 'utc')::date);

commit;
