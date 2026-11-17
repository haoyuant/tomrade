-- The site's A/B test beside the app's numbers (TOM-1110): the totals
-- tomrade.com's Worker keeps for the home page's test (tomrade-site
-- worker/ab.js), copied daily from its D1 database by tomrade-site's
-- Analytics workflow. Totals only, per day, test, version, language and kind
-- of device: no region, no address, nothing that names a person.
-- They keep 25 months, like the other aggregates.
begin;

-- Page loads, counted for everyone: view (the home page), download (an
-- installer link on it), download-page and download-via-page (the download
-- page, under the version that visitor's home page is).
-- People, told by the page for visitors who said yes: visitor, engaged (read
-- past the first screen), downloader.
create table public.tomrade_ab_daily (
  day date not null,
  test text not null check (test <> ''),
  variant text not null check (variant in ('a', 'b')),
  lang text not null check (lang in ('en', 'zh')),
  device text not null check (device in ('desktop', 'mobile')),
  event text not null check (event in ('view', 'download', 'download-page', 'download-via-page', 'visitor', 'engaged', 'downloader')),
  n bigint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (day, test, variant, lang, device, event)
);

alter table public.tomrade_ab_daily enable row level security;
revoke all on public.tomrade_ab_daily from public, anon, authenticated;

-- The sync's only write: the days from p_from to p_to are replaced by p_rows
-- ({day, test, variant, lang, device, event, n}), so a re-run, a late day or
-- a backfill lands exactly once.
create function public.tomrade_ab_sync(p_from date, p_to date, p_rows jsonb)
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

  create temporary table if not exists pg_temp.tomrade_ab_incoming (
    day date, test text, variant text, lang text, device text, event text, n bigint
  ) on commit drop;
  truncate pg_temp.tomrade_ab_incoming;
  insert into pg_temp.tomrade_ab_incoming
  select (r ->> 'day')::date,
         left(coalesce(r ->> 'test', ''), 64),
         r ->> 'variant',
         r ->> 'lang',
         r ->> 'device',
         r ->> 'event',
         greatest(coalesce((r ->> 'n')::bigint, 0), 0)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;

  if exists (select 1 from pg_temp.tomrade_ab_incoming where day is null or day < p_from or day > p_to) then
    raise exception 'a row falls outside the range' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_ab_incoming where test = '') then
    raise exception 'a row names no test' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_ab_incoming where variant is null or variant not in ('a', 'b')) then
    raise exception 'unknown variant' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_ab_incoming where lang is null or lang not in ('en', 'zh')) then
    raise exception 'unknown language' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_ab_incoming where device is null or device not in ('desktop', 'mobile')) then
    raise exception 'unknown device' using errcode = 'PT400';
  end if;
  if exists (select 1 from pg_temp.tomrade_ab_incoming
              where event is null or event not in ('view', 'download', 'download-page', 'download-via-page', 'visitor', 'engaged', 'downloader')) then
    raise exception 'unknown event' using errcode = 'PT400';
  end if;

  delete from public.tomrade_ab_daily where day between p_from and p_to;
  get diagnostics v_removed = row_count;

  insert into public.tomrade_ab_daily (day, test, variant, lang, device, event, n)
  select day, test, variant, lang, device, event, sum(n)
    from pg_temp.tomrade_ab_incoming
   group by day, test, variant, lang, device, event;
  get diagnostics v_written = row_count;

  delete from public.tomrade_ab_daily where day < ((now() at time zone 'utc')::date - interval '25 months')::date;
  get diagnostics v_expired = row_count;

  return jsonb_build_object('written', v_written, 'replaced', v_removed, 'expired', v_expired);
end;
$fn$;

-- What the dashboard reads: the range's totals per test, version, language,
-- device and event, and the days of the range each test has rows for. The
-- test has no region: p_region is accepted so the dashboard can call every
-- report alike, and ignored.
create function public.tomrade_ab_report(p_from date, p_to date, p_region text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_tests jsonb;
  v_rows jsonb;
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

  -- Newest first: the dashboard shows the test that ran last.
  select coalesce(jsonb_agg(jsonb_build_object('test', t.test, 'first_day', t.first_day, 'last_day', t.last_day)
           order by t.last_day desc, t.test), '[]'::jsonb)
    into v_tests
    from (select test, min(day) as first_day, max(day) as last_day
            from public.tomrade_ab_daily where day between p_from and p_to group by test) t;

  select coalesce(jsonb_agg(jsonb_build_object('test', t.test, 'variant', t.variant, 'lang', t.lang, 'device', t.device, 'event', t.event, 'n', t.n)
           order by t.test, t.variant, t.lang, t.device, t.event), '[]'::jsonb)
    into v_rows
    from (select test, variant, lang, device, event, sum(n) as n
            from public.tomrade_ab_daily where day between p_from and p_to
           group by test, variant, lang, device, event) t;

  -- Newest copy over the whole table: a quiet range still says whether the job runs.
  select max(synced_at) into v_synced from public.tomrade_ab_daily;

  return jsonb_build_object('from', p_from, 'to', p_to, 'synced_at', v_synced, 'tests', v_tests, 'rows', v_rows);
end;
$fn$;

revoke all on function public.tomrade_ab_sync(date, date, jsonb) from public, anon, authenticated;
revoke all on function public.tomrade_ab_report(date, date, text) from public, anon, authenticated;
-- The sync job and the dashboard both use the service role.
grant execute on function public.tomrade_ab_sync(date, date, jsonb) to service_role;
grant execute on function public.tomrade_ab_report(date, date, text) to service_role;

commit;
