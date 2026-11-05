-- The site's numbers beside the app's (TOM-999): installer and update
-- downloads from download.tomrade.com and page views of tomrade.com, copied
-- daily from Cloudflare's edge analytics by tomrade-site's sync job. Cloudflare
-- keeps them for 31 days on this plan; here they keep 25 months, like the
-- other aggregates.
--
-- The job sends a country code per row; it is reduced to the same five
-- buckets ingest uses and never stored. Nothing here can name a person.
begin;

-- The bucket ingest applies, callable on a code the edge did not put in a header.
create function public.tomrade_analytics_bucket(p_country text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when length(coalesce(p_country, '')) <> 2 then 'other'
    when upper(p_country) = 'CN' then 'cn'
    when upper(p_country) in ('JP','KR','SG','AU','NZ','IN','ID','MY','TH','VN','PH','TW','HK','MO','BD','LK','PK','MN','KH','LA','MM','BN','NP','BT','MV') then 'apac'
    when upper(p_country) in ('US','CA','MX') then 'na'
    when upper(p_country) in ('GB','CH','NO','IS','LI','AD','MC','SM','VA') then 'eu'
    when upper(p_country) in ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE') then 'eu'
    else 'other'
  end;
$fn$;

-- One list of countries: ingest now reads the bucket from the function above.
create or replace function public.tomrade_analytics_region()
returns text
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_headers jsonb;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  return public.tomrade_analytics_bucket(coalesce(
    v_headers ->> 'cf-ipcountry',
    v_headers ->> 'x-vercel-ip-country',
    v_headers ->> 'x-tomrade-country',
    ''
  ));
exception when others then
  return 'other';
end;
$fn$;

-- install: an installer fetched by anything but the app's updater.
-- update:  a file fetched by the app's updater (a Mac zip, a Windows or Linux installer).
-- page:    an HTML page of tomrade.com answered 200 to a client that is not a known crawler.
-- downloads is whole files: the bytes sent divided by the file's size, so a
-- download split into ranges counts once and an abandoned one counts in part.
create table public.tomrade_site_daily (
  day date not null,
  region text not null check (region in ('cn', 'apac', 'eu', 'na', 'other')),
  kind text not null check (kind in ('install', 'update', 'page')),
  platform text not null default '',
  version text not null default '',
  requests bigint not null default 0,
  bytes bigint not null default 0,
  downloads numeric not null default 0,
  visits bigint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, region, kind, platform, version)
);

alter table public.tomrade_site_daily enable row level security;
revoke all on public.tomrade_site_daily from public, anon, authenticated;

-- The sync's only write: the days from p_from to p_to are replaced by p_rows,
-- so a re-run, a late day or a backfill lands exactly once. A row whose bucket
-- belongs to the other deployment is dropped, as ingest would refuse it.
create function public.tomrade_site_sync(p_from date, p_to date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_written integer := 0;
  v_skipped integer := 0;
  v_removed integer := 0;
  v_expired integer := 0;
begin
  if p_from is null or p_to is null then
    raise exception 'a range needs two dates' using errcode = 'PT400';
  end if;
  if p_to < p_from then
    raise exception 'the range ends before it starts' using errcode = 'PT400';
  end if;
  if p_to - p_from > 40 then
    raise exception 'a sync covers at most 40 days' using errcode = 'PT400';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'rows must be an array' using errcode = 'PT400';
  end if;

  create temporary table if not exists pg_temp.tomrade_site_incoming (
    day date, region text, kind text, platform text, version text,
    requests bigint, bytes bigint, downloads numeric, visits bigint
  ) on commit drop;
  truncate pg_temp.tomrade_site_incoming;
  insert into pg_temp.tomrade_site_incoming
  select (r ->> 'day')::date,
         public.tomrade_analytics_bucket(r ->> 'country'),
         r ->> 'kind',
         left(coalesce(r ->> 'platform', ''), 32),
         left(coalesce(r ->> 'version', ''), 32),
         greatest(coalesce((r ->> 'requests')::bigint, 0), 0),
         greatest(coalesce((r ->> 'bytes')::bigint, 0), 0),
         greatest(coalesce((r ->> 'downloads')::numeric, 0), 0),
         greatest(coalesce((r ->> 'visits')::bigint, 0), 0)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;

  if exists (select 1 from pg_temp.tomrade_site_incoming where day is null or day < p_from or day > p_to) then
    raise exception 'a row falls outside the range' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_site_incoming where kind is null or kind not in ('install', 'update', 'page')) then
    raise exception 'unknown kind' using errcode = 'PT400';
  end if;

  select count(*) into v_skipped from pg_temp.tomrade_site_incoming where not public.tomrade_analytics_scope_allows(region);

  delete from public.tomrade_site_daily where day between p_from and p_to;
  get diagnostics v_removed = row_count;

  insert into public.tomrade_site_daily (day, region, kind, platform, version, requests, bytes, downloads, visits)
  select day, region, kind, platform, version, sum(requests), sum(bytes), sum(downloads), sum(visits)
    from pg_temp.tomrade_site_incoming
   where public.tomrade_analytics_scope_allows(region)
   group by day, region, kind, platform, version;
  get diagnostics v_written = row_count;

  delete from public.tomrade_site_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_expired = row_count;

  return jsonb_build_object('written', v_written, 'replaced', v_removed, 'skipped', v_skipped, 'expired', v_expired);
end;
$fn$;

-- What the dashboard reads. Downloads are rounded once, after summing.
create function public.tomrade_site_report(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_region text := p_region;
  v_totals jsonb;
  v_daily jsonb;
  v_platforms jsonb;
  v_versions jsonb;
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
  if v_region = 'all' then v_region := null; end if;
  if v_region is not null and v_region not in ('cn', 'apac', 'eu', 'na', 'other') then
    raise exception 'unknown region %', v_region using errcode = 'PT400';
  end if;

  select jsonb_build_object(
    'installs', coalesce(round(sum(downloads) filter (where kind = 'install')), 0),
    'updates', coalesce(round(sum(downloads) filter (where kind = 'update')), 0),
    'pageviews', coalesce(sum(requests) filter (where kind = 'page'), 0),
    'visits', coalesce(sum(visits) filter (where kind = 'page'), 0)
  ) into v_totals
    from public.tomrade_site_daily where day between p_from and p_to and (v_region is null or region = v_region);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', t.day, 'installs', t.installs, 'updates', t.updates, 'pageviews', t.pageviews, 'visits', t.visits
         ) order by t.day), '[]'::jsonb)
    into v_daily
    from (select day,
                 coalesce(round(sum(downloads) filter (where kind = 'install')), 0) as installs,
                 coalesce(round(sum(downloads) filter (where kind = 'update')), 0) as updates,
                 coalesce(sum(requests) filter (where kind = 'page'), 0) as pageviews,
                 coalesce(sum(visits) filter (where kind = 'page'), 0) as visits
            from public.tomrade_site_daily where day between p_from and p_to and (v_region is null or region = v_region)
           group by day) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', t.platform, 'installs', t.installs, 'updates', t.updates
         ) order by t.installs desc, t.platform), '[]'::jsonb)
    into v_platforms
    from (select platform,
                 coalesce(round(sum(downloads) filter (where kind = 'install')), 0) as installs,
                 coalesce(round(sum(downloads) filter (where kind = 'update')), 0) as updates
            from public.tomrade_site_daily where day between p_from and p_to and (v_region is null or region = v_region) and kind <> 'page' group by platform) t;

  select coalesce(jsonb_agg(jsonb_build_object(
           'version', t.version, 'installs', t.installs, 'updates', t.updates
         ) order by t.version desc), '[]'::jsonb)
    into v_versions
    from (select version,
                 coalesce(round(sum(downloads) filter (where kind = 'install')), 0) as installs,
                 coalesce(round(sum(downloads) filter (where kind = 'update')), 0) as updates
            from public.tomrade_site_daily where day between p_from and p_to and (v_region is null or region = v_region) and kind <> 'page' group by version) t;

  -- Newest copy over the whole table: a quiet range still says whether the job runs.
  select max(synced_at) into v_synced from public.tomrade_site_daily;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'region', v_region, 'synced_at', v_synced,
    'totals', v_totals, 'daily', v_daily, 'platforms', v_platforms, 'versions', v_versions
  );
end;
$fn$;

revoke all on function public.tomrade_analytics_bucket(text) from public, anon, authenticated;
revoke all on function public.tomrade_site_sync(date, date, jsonb) from public, anon, authenticated;
revoke all on function public.tomrade_site_report(date, date, text) from public, anon, authenticated;
-- The sync job and the dashboard both use the service role.
grant execute on function public.tomrade_site_sync(date, date, jsonb) to service_role;
grant execute on function public.tomrade_site_report(date, date, text) to service_role;

commit;
