-- Roll raw events into the three tables the dashboard reads, and answer one
-- query for a whole report. The metric definitions here are the ones in
-- Tomrade 功能清单与埋点规范 §6; the dashboard does not derive its own.
--
-- Re-running a range is safe: the three tables are rewritten for those days,
-- so a late event (a queue that waited, a backfill) is folded in exactly once.
-- Schedule the refresh from the deployment's scheduler; see docs/analytics.md.
begin;

create function public.tomrade_analytics_aggregate(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_actors integer := 0;
  v_star integer := 0;
  v_features integer := 0;
  v_actions integer := 0;
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
  v_from := p_from::timestamptz;
  v_to := (p_to + 1)::timestamptz;

  delete from public.tomrade_analytics_actor_daily where day between p_from and p_to;
  delete from public.tomrade_analytics_feature_daily where day between p_from and p_to;
  delete from public.tomrade_analytics_action_daily where day between p_from and p_to;

  -- One row per person, feature and UTC day; '*' is any activity at all.
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

  -- Sessions and active time come only from feature.session; actors from every
  -- event of the day, including an action-only feature with no session.
  insert into public.tomrade_analytics_feature_daily (day, region, feature_id, client_minor, sessions, active_ms, actors)
  select (e.ts at time zone 'utc')::date,
         e.region,
         e.feature_id,
         split_part(e.client, '.', 1) || '.' || split_part(e.client, '.', 2),
         count(*) filter (where e.event = 'feature.session'),
         coalesce(sum(e.active_ms) filter (where e.event = 'feature.session'), 0),
         count(distinct e.anon_id)
    from public.tomrade_analytics_event e
   where e.ts >= v_from and e.ts < v_to and e.feature_id is not null
   group by 1, 2, 3, 4;
  get diagnostics v_features = row_count;

  -- Action events and the subset that counts as a use. `counted` was fixed
  -- when the event arrived, so a later registry change never rewrites history.
  insert into public.tomrade_analytics_action_daily (day, region, feature_id, action, dim, client_minor, events, counted_events, actors)
  select (e.ts at time zone 'utc')::date,
         e.region,
         e.feature_id,
         e.action,
         coalesce(e.dim, ''),
         split_part(e.client, '.', 1) || '.' || split_part(e.client, '.', 2),
         count(*),
         count(*) filter (where e.counted),
         count(distinct e.anon_id)
    from public.tomrade_analytics_event e
   where e.event = 'feature.activate' and e.ts >= v_from and e.ts < v_to
   group by 1, 2, 3, 4, 5, 6;
  get diagnostics v_actions = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'actors', v_actors + v_star, 'features', v_features, 'actions', v_actions);
end;
$fn$;

/**
 * One report for the dashboard: totals, the daily series, features and actions,
 * and the retention of the cohorts first seen in the range. A region narrows
 * every number; null or 'all' is both deployments at once. Days with no data
 * are absent, never zero-filled.
 */
create function public.tomrade_analytics_report(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := nullif(p_region, '');
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
                              where day between p_from and p_to and (v_region is null or region = v_region)), 0),
    'sessions', coalesce((select sum(sessions) from public.tomrade_analytics_feature_daily
                           where day between p_from and p_to and (v_region is null or region = v_region)), 0),
    'uses', coalesce((select sum(counted_events) from public.tomrade_analytics_action_daily
                       where day between p_from and p_to and (v_region is null or region = v_region)), 0),
    'aai', coalesce((select count(distinct anon_id) from public.tomrade_analytics_actor_daily
                      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region)), 0)
  ) into v_totals;

  with days as (
    select day from public.tomrade_analytics_feature_daily
      where day between p_from and p_to and (v_region is null or region = v_region)
    union
    select day from public.tomrade_analytics_action_daily
      where day between p_from and p_to and (v_region is null or region = v_region)
    union
    select day from public.tomrade_analytics_actor_daily
      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region)
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
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by day) f on f.day = d.day
    left join (select day, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by day) a on a.day = d.day
    left join (select day, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region)
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
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by feature_id) f on f.feature_id = k.feature_id
    left join (select feature_id, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by feature_id) a on a.feature_id = k.feature_id
    left join (select feature_id, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id <> '*' and day between p_from and p_to and (v_region is null or region = v_region)
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
           where day between p_from and p_to and (v_region is null or region = v_region)
           group by feature_id, action) t;

  -- Cohorts are people first seen inside the range; a return is any event on
  -- the exact calendar day after it. D+7 and D+30 may still be in the future.
  with scoped as (
    select anon_id, day from public.tomrade_analytics_actor_daily
     where feature_id = '*' and day between p_from and p_to + 30
       and (v_region is null or region = v_region)
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
      where day between p_from and p_to and (v_region is null or region = v_region)
    union
    select region from public.tomrade_analytics_action_daily
      where day between p_from and p_to and (v_region is null or region = v_region)
    union
    select region from public.tomrade_analytics_actor_daily
      where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region)
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
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by region) f on f.region = r.region
    left join (select region, sum(counted_events) as uses
                 from public.tomrade_analytics_action_daily
                where day between p_from and p_to and (v_region is null or region = v_region)
                group by region) a on a.region = r.region
    left join (select region, count(distinct anon_id) as aai
                 from public.tomrade_analytics_actor_daily
                where feature_id = '*' and day between p_from and p_to and (v_region is null or region = v_region)
                group by region) u on u.region = r.region;

  select max(received_at) into v_latest
    from public.tomrade_analytics_event
   where ts >= v_from and ts < v_to;

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

revoke all on function public.tomrade_analytics_aggregate(date, date) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_report(date, date, text) from public, anon, authenticated;

-- Hourly, the last three days; nightly, the last 35. Re-running is the retry.
-- select cron.schedule('tomrade-analytics-hourly', '7 * * * *',
--                      $$select public.tomrade_analytics_aggregate(current_date - 2, current_date)$$);
-- select cron.schedule('tomrade-analytics-nightly', '23 2 * * *',
--                      $$select public.tomrade_analytics_aggregate(current_date - 34, current_date)$$);

commit;
