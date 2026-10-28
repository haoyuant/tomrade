-- Registry 2 and the activation funnel (TOM-749).
--
-- Registry 2 is registry 1 plus five actions that answer how far a new install
-- gets from an idea to a merge. None of them is counted as a use and none
-- carries a dim: they exist for adoption and the funnel only.
--
--   onboarding / setup_done           the first-run check passes, once per anonymous id
--   code.link  / project_repo_linked  a repository added to a project
--   code.link  / claim_external       an agent in the person's own terminal claimed a ticket
--   agent.chat / plan_applied         a proposed requirement tree written to the backlog
--   agent.chat / run_reverted         a whole run undone
--
-- It mirrors packages/analytics/src/features.ts; the package's tests compare
-- the two, so a registry change without its migration fails CI.
begin;

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims)
select 2, feature_id, action, counted, dims
  from public.tomrade_analytics_registry
 where registry = 1;

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims) values
  (2, 'onboarding', 'setup_done', false, null),
  (2, 'code.link', 'project_repo_linked', false, null),
  (2, 'code.link', 'claim_external', false, null),
  (2, 'agent.chat', 'plan_applied', false, null),
  (2, 'agent.chat', 'run_reverted', false, null);

/**
 * The activation funnel for installs first seen in the range: install →
 * setup_done → the first code.link start → open_pr → merge, each step counting
 * the installs that also reached every step before it. Alongside it:
 *
 *   first_start   median time from install to the first code.link start, and how many started
 *   merged_7d     of installs at least seven days old, those that merged within seven days
 *   week_return   of installs whose first week is over, those back on any of the UTC days D+1…D+7
 *
 * An install is an anonymous id whose earliest kept event falls in the range:
 * every client sends app.start first, and a rotated or reset id is a new
 * install here as everywhere else. Detail is kept 180 days, so an id idle for
 * longer than that and back again counts as new. Steps reached after the range
 * still count: the funnel follows the cohort up to now.
 */
create function public.tomrade_analytics_activation(p_from date, p_to date, p_region text default null)
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
     where v_region is null or e.region = v_region
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
           min(s.ts) filter (where s.event = 'feature.activate' and s.feature_id = 'code.link' and s.action = 'start') as start_at,
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

revoke all on function public.tomrade_analytics_activation(date, date, text) from public, anon, authenticated;
grant execute on function public.tomrade_analytics_activation(date, date, text) to service_role;

commit;
