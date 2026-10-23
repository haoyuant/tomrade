-- The dashboard's detail series: one row per feature, UTC day and coarse
-- region, with the three numbers it plots. The page never derives these from
-- raw events; it adds rows the aggregation already wrote.
begin;

create function public.tomrade_analytics_feature_days(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := nullif(p_region, '');
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
                    where day between p_from and p_to
                    group by day, region, feature_id) a
          on a.day = f.day and a.region = f.region and a.feature_id = f.feature_id
       where f.day between p_from and p_to and (v_region is null or f.region = v_region)
       group by f.day, f.region, f.feature_id
    ) d;

  return jsonb_build_object('from', p_from, 'to', p_to, 'region', v_region, 'days', v_days);
end;
$fn$;

revoke all on function public.tomrade_analytics_feature_days(date, date, text) from public, anon, authenticated;

grant execute on function public.tomrade_analytics_report(date, date, text) to service_role;
grant execute on function public.tomrade_analytics_feature_days(date, date, text) to service_role;

commit;
