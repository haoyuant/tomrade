-- Search and GitHub numbers beside the app's (TOM-1030), copied daily by
-- tomrade-site's Analytics workflow:
--   - Google Search Console for tomrade.com: clicks, impressions and position
--     per day, and per day for the top queries and landing pages;
--   - GitHub for the app's repository: views and clones per day (GitHub keeps
--     14 days), and a snapshot per sync day of stars, forks, watchers and the
--     top referrers and paths (GitHub only reports those over its last 14 days).
-- Neither carries a region or anything that names a person: queries are what
-- Search Console reports (it leaves out rare ones), referrers are sites.
-- They keep 25 months, like the other aggregates.
begin;

-- dimension 'total' is the day's whole; 'query' and 'page' its top rows.
-- position_sum is position × impressions, so averages weigh by impressions.
create table public.tomrade_search_daily (
  day date not null,
  dimension text not null check (dimension in ('total', 'query', 'page')),
  key text not null default '',
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  position_sum numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, dimension, key)
);

create table public.tomrade_github_daily (
  day date not null,
  repo text not null,
  views bigint not null default 0,
  view_uniques bigint not null default 0,
  clones bigint not null default 0,
  clone_uniques bigint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, repo)
);

-- What the repository looked like on the day the sync ran.
create table public.tomrade_github_snapshot (
  day date not null,
  repo text not null,
  stars bigint not null default 0,
  forks bigint not null default 0,
  watchers bigint not null default 0,
  views_14d bigint not null default 0,
  view_uniques_14d bigint not null default 0,
  clones_14d bigint not null default 0,
  clone_uniques_14d bigint not null default 0,
  referrers jsonb not null default '[]'::jsonb,
  paths jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (day, repo)
);

alter table public.tomrade_search_daily enable row level security;
alter table public.tomrade_github_daily enable row level security;
alter table public.tomrade_github_snapshot enable row level security;
revoke all on public.tomrade_search_daily from public, anon, authenticated;
revoke all on public.tomrade_github_daily from public, anon, authenticated;
revoke all on public.tomrade_github_snapshot from public, anon, authenticated;

-- The search sync's only write: the days from p_from to p_to are replaced by
-- p_rows ({day, dimension, key, clicks, impressions, position}), so a re-run,
-- a late day or a backfill lands exactly once.
create function public.tomrade_search_sync(p_from date, p_to date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_written integer := 0;
  v_removed integer := 0;
  v_expired integer := 0;
begin
  if p_from is null or p_to is null then
    raise exception 'a range needs two dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the range ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 120 then
    raise exception 'a sync covers at most 120 days' using errcode = 'PT400';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'rows must be an array' using errcode = 'PT400';
  end if;

  create temporary table if not exists pg_temp.tomrade_search_incoming (
    day date, dimension text, key text, clicks bigint, impressions bigint, position_sum numeric
  ) on commit drop;
  truncate pg_temp.tomrade_search_incoming;
  insert into pg_temp.tomrade_search_incoming
  select (r ->> 'day')::date,
         r ->> 'dimension',
         left(coalesce(r ->> 'key', ''), 512),
         greatest(coalesce((r ->> 'clicks')::bigint, 0), 0),
         greatest(coalesce((r ->> 'impressions')::bigint, 0), 0),
         greatest(coalesce((r ->> 'position')::numeric, 0), 0) * greatest(coalesce((r ->> 'impressions')::bigint, 0), 0)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;

  if exists (select 1 from pg_temp.tomrade_search_incoming where day is null or day < p_from or day > p_to) then
    raise exception 'a row falls outside the range' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_search_incoming where dimension is null or dimension not in ('total', 'query', 'page')) then
    raise exception 'unknown dimension' using errcode = 'PT400';
  end if;

  delete from public.tomrade_search_daily where day between p_from and p_to;
  get diagnostics v_removed = row_count;

  insert into public.tomrade_search_daily (day, dimension, key, clicks, impressions, position_sum)
  select day, dimension, case when dimension = 'total' then '' else key end, sum(clicks), sum(impressions), sum(position_sum)
    from pg_temp.tomrade_search_incoming
   group by day, dimension, case when dimension = 'total' then '' else key end;
  get diagnostics v_written = row_count;

  delete from public.tomrade_search_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_expired = row_count;

  return jsonb_build_object('written', v_written, 'replaced', v_removed, 'expired', v_expired);
end;
$fn$;

-- The GitHub sync's only write: p_from to p_to's daily rows are replaced by
-- p_days ({day, views, view_uniques, clones, clone_uniques}), and the snapshot
-- of p_snapshot_day is written or replaced.
create function public.tomrade_github_sync(p_repo text, p_from date, p_to date, p_days jsonb, p_snapshot_day date, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_written integer := 0;
  v_removed integer := 0;
  v_expired integer := 0;
begin
  if coalesce(p_repo, '') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then
    raise exception 'a repository is owner/name' using errcode = 'PT400';
  end if;
  if p_from is null or p_to is null or p_snapshot_day is null then
    raise exception 'a sync needs its dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the range ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 40 then
    raise exception 'a sync covers at most 40 days' using errcode = 'PT400';
  end if;
  if jsonb_typeof(coalesce(p_days, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_snapshot, '{}'::jsonb)) <> 'object' then
    raise exception 'days must be an array and the snapshot an object' using errcode = 'PT400';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) r
              where (r ->> 'day')::date is null or (r ->> 'day')::date < p_from or (r ->> 'day')::date > p_to) then
    raise exception 'a row falls outside the range' using errcode = 'PT400';
  end if;

  delete from public.tomrade_github_daily where repo = p_repo and day between p_from and p_to;
  get diagnostics v_removed = row_count;

  insert into public.tomrade_github_daily (day, repo, views, view_uniques, clones, clone_uniques)
  select (r ->> 'day')::date, p_repo,
         sum(greatest(coalesce((r ->> 'views')::bigint, 0), 0)),
         sum(greatest(coalesce((r ->> 'view_uniques')::bigint, 0), 0)),
         sum(greatest(coalesce((r ->> 'clones')::bigint, 0), 0)),
         sum(greatest(coalesce((r ->> 'clone_uniques')::bigint, 0), 0))
    from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) r
   group by (r ->> 'day')::date;
  get diagnostics v_written = row_count;

  -- Only the lists' first 10 rows, with only the fields the dashboard shows.
  insert into public.tomrade_github_snapshot (day, repo, stars, forks, watchers, views_14d, view_uniques_14d, clones_14d, clone_uniques_14d, referrers, paths)
  values (
    p_snapshot_day, p_repo,
    greatest(coalesce((p_snapshot ->> 'stars')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'forks')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'watchers')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'views_14d')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'view_uniques_14d')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'clones_14d')::bigint, 0), 0),
    greatest(coalesce((p_snapshot ->> 'clone_uniques_14d')::bigint, 0), 0),
    coalesce((select jsonb_agg(jsonb_build_object(
               'referrer', left(coalesce(r ->> 'referrer', ''), 200),
               'count', greatest(coalesce((r ->> 'count')::bigint, 0), 0),
               'uniques', greatest(coalesce((r ->> 'uniques')::bigint, 0), 0)) order by n)
               from jsonb_array_elements(case when jsonb_typeof(p_snapshot -> 'referrers') = 'array' then p_snapshot -> 'referrers' else '[]'::jsonb end) with ordinality as e(r, n)
              where n <= 10), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
               'path', left(coalesce(r ->> 'path', ''), 300),
               'title', left(coalesce(r ->> 'title', ''), 300),
               'count', greatest(coalesce((r ->> 'count')::bigint, 0), 0),
               'uniques', greatest(coalesce((r ->> 'uniques')::bigint, 0), 0)) order by n)
               from jsonb_array_elements(case when jsonb_typeof(p_snapshot -> 'paths') = 'array' then p_snapshot -> 'paths' else '[]'::jsonb end) with ordinality as e(r, n)
              where n <= 10), '[]'::jsonb)
  )
  on conflict (day, repo) do update set
    stars = excluded.stars, forks = excluded.forks, watchers = excluded.watchers,
    views_14d = excluded.views_14d, view_uniques_14d = excluded.view_uniques_14d,
    clones_14d = excluded.clones_14d, clone_uniques_14d = excluded.clone_uniques_14d,
    referrers = excluded.referrers, paths = excluded.paths, synced_at = now();

  delete from public.tomrade_github_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_expired = row_count;
  delete from public.tomrade_github_snapshot where day < ((now() at time zone 'utc')::date - interval '25 months')::date;

  return jsonb_build_object('written', v_written, 'replaced', v_removed, 'expired', v_expired);
end;
$fn$;

-- What the dashboard reads. Neither source has a region: p_region is accepted
-- so the dashboard can call every report alike, and ignored.
create function public.tomrade_search_report(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_totals jsonb;
  v_daily jsonb;
  v_queries jsonb;
  v_pages jsonb;
  v_synced timestamptz;
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

  select jsonb_build_object('clicks', coalesce(sum(clicks), 0), 'impressions', coalesce(sum(impressions), 0), 'position_sum', coalesce(sum(position_sum), 0))
    into v_totals
    from public.tomrade_search_daily where dimension = 'total' and day between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'clicks', clicks, 'impressions', impressions, 'position_sum', position_sum) order by day), '[]'::jsonb)
    into v_daily
    from public.tomrade_search_daily where dimension = 'total' and day between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'clicks', t.clicks, 'impressions', t.impressions, 'position_sum', t.position_sum)
           order by t.clicks desc, t.impressions desc, t.key), '[]'::jsonb)
    into v_queries
    from (select key, sum(clicks) as clicks, sum(impressions) as impressions, sum(position_sum) as position_sum
            from public.tomrade_search_daily where dimension = 'query' and day between p_from and p_to
           group by key order by sum(clicks) desc, sum(impressions) desc, key limit 25) t;

  select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'clicks', t.clicks, 'impressions', t.impressions, 'position_sum', t.position_sum)
           order by t.clicks desc, t.impressions desc, t.key), '[]'::jsonb)
    into v_pages
    from (select key, sum(clicks) as clicks, sum(impressions) as impressions, sum(position_sum) as position_sum
            from public.tomrade_search_daily where dimension = 'page' and day between p_from and p_to
           group by key order by sum(clicks) desc, sum(impressions) desc, key limit 25) t;

  -- Newest copy over the whole table: a quiet range still says whether the job runs.
  select max(synced_at) into v_synced from public.tomrade_search_daily;

  return jsonb_build_object('from', p_from, 'to', p_to, 'synced_at', v_synced,
    'totals', v_totals, 'daily', v_daily, 'queries', v_queries, 'pages', v_pages);
end;
$fn$;

create function public.tomrade_github_report(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_totals jsonb;
  v_daily jsonb;
  v_first jsonb;
  v_last jsonb;
  v_synced timestamptz;
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

  select jsonb_build_object('views', coalesce(sum(views), 0), 'clones', coalesce(sum(clones), 0))
    into v_totals
    from public.tomrade_github_daily where day between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('day', t.day, 'views', t.views, 'view_uniques', t.view_uniques, 'clones', t.clones, 'clone_uniques', t.clone_uniques) order by t.day), '[]'::jsonb)
    into v_daily
    from (select day, sum(views) as views, sum(view_uniques) as view_uniques, sum(clones) as clones, sum(clone_uniques) as clone_uniques
            from public.tomrade_github_daily where day between p_from and p_to group by day) t;

  -- The stars at the start of the range are the last snapshot before it, or its first one.
  select to_jsonb(s) - 'synced_at' into v_first
    from public.tomrade_github_snapshot s where s.day <= p_to
   order by (s.day < p_from) desc, case when s.day < p_from then s.day end desc nulls last, s.day asc limit 1;
  select to_jsonb(s) - 'synced_at' into v_last
    from public.tomrade_github_snapshot s where s.day <= p_to order by s.day desc limit 1;

  select greatest(
           (select max(synced_at) from public.tomrade_github_daily),
           (select max(synced_at) from public.tomrade_github_snapshot))
    into v_synced;

  return jsonb_build_object('from', p_from, 'to', p_to, 'synced_at', v_synced,
    'totals', v_totals, 'daily', v_daily, 'first', v_first, 'last', v_last);
end;
$fn$;

revoke all on function public.tomrade_search_sync(date, date, jsonb) from public, anon, authenticated;
revoke all on function public.tomrade_github_sync(text, date, date, jsonb, date, jsonb) from public, anon, authenticated;
revoke all on function public.tomrade_search_report(date, date, text) from public, anon, authenticated;
revoke all on function public.tomrade_github_report(date, date, text) from public, anon, authenticated;
-- The sync job and the dashboard both use the service role.
grant execute on function public.tomrade_search_sync(date, date, jsonb) to service_role;
grant execute on function public.tomrade_github_sync(text, date, date, jsonb, date, jsonb) to service_role;
grant execute on function public.tomrade_search_report(date, date, text) to service_role;
grant execute on function public.tomrade_github_report(date, date, text) to service_role;

commit;
