-- A registry version that lands after its release re-judges what that release
-- already sent (TOM-1064). Until then ingest answers from the newest registry
-- below the event's own (202611110101), so an action new in that version is
-- stored uncounted and its feature, when new too, as unknown; before this,
-- only a hand-written backfill turned them into uses.
--
-- Rows for a version arrive once, in its migration, so every stored event of
-- that version came before them and none was judged by them yet: each one a
-- new row matches takes the row's `counted`, its feature stops being unknown,
-- and every day touched is rolled up again (the rollup rewrites a day whole).
-- A dim dropped at ingest stays dropped; the event no longer has it.
begin;

create or replace function public.tomrade_analytics_registry_recount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_days date[];
  v_day date;
begin
  -- Two statements: one statement may not update the same row twice.
  update public.tomrade_analytics_event e
     set unknown_feature = false
   where e.unknown_feature
     and exists (select 1 from added r where r.registry = e.registry and r.feature_id = e.feature_id);

  with judged as (
    update public.tomrade_analytics_event e
       set counted = r.counted
      from added r
     where e.event = 'feature.activate'
       and e.registry = r.registry
       and e.feature_id = r.feature_id
       and e.action = r.action
       and e.counted is distinct from r.counted
    returning (e.ts at time zone 'utc')::date as day
  )
  select array_agg(distinct day order by day) into v_days from judged;
  foreach v_day in array coalesce(v_days, '{}') loop
    perform public.tomrade_analytics_aggregate(v_day, v_day);
  end loop;
  return null;
end;
$fn$;

revoke all on function public.tomrade_analytics_registry_recount() from public, anon, authenticated;

create trigger tomrade_analytics_registry_recount
after insert on public.tomrade_analytics_registry
referencing new table as added
for each statement execute function public.tomrade_analytics_registry_recount();

commit;
