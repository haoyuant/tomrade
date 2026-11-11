-- A release can ship before the migration that adds its registry version, and
-- until then ingest knew none of that version's rows: every action arrived as an
-- unknown feature, stored with counted=false, and uses fell to nearly nothing
-- for 2026-10-28…11-02 while active time stayed whole (TOM-1059).
--
-- Ingest now reads the newest registry at or below the event's own. Registries
-- only ever add rows, so the older one answers rightly for everything it has;
-- an action it lacks is kept uncounted rather than refused. The stored
-- `registry` stays what the client sent.
begin;

create or replace function public.tomrade_ingest_analytics(p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_events jsonb;
  v_event jsonb;
  v_first jsonb;
  v_event_name text;
  v_anon text;
  v_region text;
  v_count integer;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected integer := 0;
  v_batches integer;
  v_rows integer;
  v_ts timestamptz;
  v_started timestamptz;
  v_ended timestamptz;
  v_active integer;
  v_idle integer;
  v_segments integer;
  v_reason text;
  v_registry smallint;
  v_known smallint;
  v_feature text;
  v_action text;
  v_dim text;
  v_dims text[];
  v_counted boolean;
  v_unknown boolean;
  v_adjusted boolean;
  v_session uuid;
  v_event_id uuid;
  v_install bigint;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    raise exception 'batch must be an object' using errcode = 'PT400';
  end if;
  if not (p_batch ? 'batch_id' and p_batch ? 'sent_at' and p_batch ? 'events')
     or exists (select 1 from jsonb_object_keys(p_batch) as key where key not in ('batch_id', 'sent_at', 'events')) then
    raise exception 'batch has fields outside the contract' using errcode = 'PT400';
  end if;
  if (p_batch ->> 'batch_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'batch_id is not a uuid' using errcode = 'PT400';
  end if;
  if (p_batch ->> 'sent_at') !~ '^[0-9]{13}$' then
    raise exception 'sent_at is not epoch milliseconds' using errcode = 'PT400';
  end if;
  if jsonb_typeof(p_batch -> 'events') <> 'array' then
    raise exception 'events must be an array' using errcode = 'PT400';
  end if;
  v_count := jsonb_array_length(p_batch -> 'events');
  if v_count = 0 then
    raise exception 'a batch needs at least one event' using errcode = 'PT400';
  end if;
  if v_count > 500 then
    raise exception 'a batch holds at most 500 events' using errcode = 'PT413';
  end if;

  v_events := p_batch -> 'events';
  v_first := v_events -> 0;
  if jsonb_typeof(v_first) <> 'object'
     or (v_first ->> 'anon_id') !~ '^[a-z2-7]{26}$' then
    raise exception 'the first event has no valid anon_id' using errcode = 'PT400';
  end if;
  v_anon := v_first ->> 'anon_id';

  -- Sixty batches an hour for one anonymous id; far above a real client, low enough to blunt abuse.
  insert into public.tomrade_analytics_rate (anon_id, window_start, batches)
  values (v_anon, now(), 1)
  on conflict (anon_id) do update
    set batches = case when public.tomrade_analytics_rate.window_start < now() - interval '1 hour' then 1 else public.tomrade_analytics_rate.batches + 1 end,
        window_start = case when public.tomrade_analytics_rate.window_start < now() - interval '1 hour' then now() else public.tomrade_analytics_rate.window_start end
  returning batches into v_batches;
  if v_batches > 60 then
    raise exception 'too many batches for this identifier' using errcode = 'PT429';
  end if;

  v_region := public.tomrade_analytics_region();

  for v_event in select value from jsonb_array_elements(v_events) loop
    if jsonb_typeof(v_event) <> 'object' then
      raise exception 'an event must be an object' using errcode = 'PT400';
    end if;
    v_event_name := v_event ->> 'event';
    if v_event_name is null or v_event_name not in ('app.start', 'feature.activate', 'feature.session') then
      raise exception 'unknown event name' using errcode = 'PT400';
    end if;

    -- The whitelist is per event kind: a field the contract does not know rejects the whole batch.
    if v_event_name = 'app.start' then
      if exists (select 1 from jsonb_object_keys(v_event) as key where key not in
        ('schema','registry','event','event_id','anon_id','install_seq','ts','client','platform','feature_id','action','dim','first_run')) then
        raise exception 'an app.start event has fields outside the contract' using errcode = 'PT400';
      end if;
      if v_event ? 'feature_id' and jsonb_typeof(v_event -> 'feature_id') <> 'null' then
        raise exception 'app.start has a feature' using errcode = 'PT400';
      end if;
      if v_event ? 'first_run' and jsonb_typeof(v_event -> 'first_run') <> 'boolean' then
        raise exception 'first_run is not a boolean' using errcode = 'PT400';
      end if;
    elsif v_event_name = 'feature.activate' then
      if exists (select 1 from jsonb_object_keys(v_event) as key where key not in
        ('schema','registry','event','event_id','anon_id','install_seq','ts','client','platform','feature_id','action','dim')) then
        raise exception 'an activate event has fields outside the contract' using errcode = 'PT400';
      end if;
      if coalesce(v_event ->> 'feature_id', '') = '' or coalesce(v_event ->> 'action', '') = '' then
        raise exception 'an activate event needs a feature and an action' using errcode = 'PT400';
      end if;
    else
      if exists (select 1 from jsonb_object_keys(v_event) as key where key not in
        ('schema','registry','event','event_id','anon_id','install_seq','ts','client','platform','feature_id','action','dim','session_id','started_at','ended_at','active_ms','idle_ms','segments','end_reason')) then
        raise exception 'a session event has fields outside the contract' using errcode = 'PT400';
      end if;
      if coalesce(v_event ->> 'feature_id', '') = '' then
        raise exception 'a session event needs a feature' using errcode = 'PT400';
      end if;
    end if;

    if (v_event ->> 'schema') is distinct from '1' then
      raise exception 'unsupported schema version' using errcode = 'PT400';
    end if;
    if (v_event ->> 'registry') !~ '^[1-9][0-9]{0,4}$' then
      raise exception 'registry is not a version' using errcode = 'PT400';
    end if;
    v_registry := (v_event ->> 'registry')::smallint;
    select max(r.registry) into v_known from public.tomrade_analytics_registry r where r.registry <= v_registry;
    if (v_event ->> 'event_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'event_id is not a uuid' using errcode = 'PT400';
    end if;
    v_event_id := (v_event ->> 'event_id')::uuid;
    if (v_event ->> 'anon_id') !~ '^[a-z2-7]{26}$' then
      raise exception 'anon_id is not a 26-character base32 id' using errcode = 'PT400';
    end if;
    if (v_event ->> 'anon_id') <> v_anon then
      raise exception 'a batch mixes anonymous ids' using errcode = 'PT400';
    end if;
    if (v_event ->> 'install_seq') !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'install_seq is not a positive integer' using errcode = 'PT400';
    end if;
    v_install := (v_event ->> 'install_seq')::bigint;
    if (v_event ->> 'ts') !~ '^[0-9]{13}$' then
      raise exception 'ts is not epoch milliseconds' using errcode = 'PT400';
    end if;
    v_ts := to_timestamp((v_event ->> 'ts')::bigint / 1000.0);
    if coalesce(v_event ->> 'client', '') !~ '^[0-9]+\.[0-9]+\.[0-9]+' then
      raise exception 'client is not a version' using errcode = 'PT400';
    end if;
    if coalesce(v_event ->> 'platform', '') not in ('macos', 'windows', 'linux') then
      raise exception 'platform is not one of three' using errcode = 'PT400';
    end if;

    v_adjusted := false;
    if v_ts > now() + interval '1 day' then
      v_ts := now();
      v_adjusted := true;
    end if;
    if v_ts < now() - interval '30 days' then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_feature := v_event ->> 'feature_id';
    v_action := case when v_event_name = 'feature.activate' then v_event ->> 'action' else null end;
    v_dim := nullif(v_event ->> 'dim', '');
    v_counted := false;
    v_unknown := false;
    v_session := null;
    v_started := null;
    v_ended := null;
    v_active := null;
    v_idle := null;
    v_segments := null;
    v_reason := null;

    if v_feature is not null then
      select not exists (select 1 from public.tomrade_analytics_registry r where r.registry = v_known and r.feature_id = v_feature)
        into v_unknown;
    end if;

    if v_event_name = 'feature.activate' then
      select r.counted, r.dims into v_counted, v_dims
        from public.tomrade_analytics_registry r
       where r.registry = v_known and r.feature_id = v_feature and r.action = v_action;
      if not found then
        -- An action newer than the registry this server has is kept, like a feature.
        if v_unknown or v_known is distinct from v_registry then
          v_counted := false;
          v_dims := null;
        else
          v_rejected := v_rejected + 1;
          continue;
        end if;
      end if;
      if v_dim is not null and (v_dims is null or not (v_dim = any (v_dims))) then
        v_dim := null;
      end if;
    else
      v_dim := null;
    end if;

    if v_event_name = 'feature.session' then
      if (v_event ->> 'session_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (v_event ->> 'started_at') !~ '^[0-9]{13}$'
         or (v_event ->> 'ended_at') !~ '^[0-9]{13}$'
         or (v_event ->> 'active_ms') !~ '^[0-9]{1,8}$'
         or (v_event ->> 'idle_ms') !~ '^[0-9]{1,12}$'
         or (v_event ->> 'segments') !~ '^[1-9][0-9]{0,3}$'
         or (v_event ->> 'end_reason') not in ('switch','blur','idle','lock','suspend','quit','crash','cap') then
        raise exception 'a session event is malformed' using errcode = 'PT400';
      end if;
      v_session := (v_event ->> 'session_id')::uuid;
      v_started := to_timestamp((v_event ->> 'started_at')::bigint / 1000.0);
      v_ended := to_timestamp((v_event ->> 'ended_at')::bigint / 1000.0);
      v_active := (v_event ->> 'active_ms')::integer;
      v_idle := (v_event ->> 'idle_ms')::integer;
      v_segments := (v_event ->> 'segments')::smallint;
      v_reason := v_event ->> 'end_reason';
      if v_ended < v_started
         or v_active > 86400000
         or v_active > floor(extract(epoch from (v_ended - v_started)) * 1000) then
        v_rejected := v_rejected + 1;
        continue;
      end if;
    end if;

    perform public.tomrade_analytics_ensure_month(v_ts);
    insert into public.tomrade_analytics_event (
      event_id, schema, registry, event, anon_id, install_seq, ts, client, platform,
      feature_id, action, dim, session_id, started_at, ended_at, active_ms, idle_ms, segments, end_reason,
      region, counted, unknown_feature, time_adjusted
    ) values (
      v_event_id, 1, v_registry, v_event_name, v_anon, v_install, v_ts, v_event ->> 'client', v_event ->> 'platform',
      v_feature, v_action, v_dim, v_session, v_started, v_ended, v_active, v_idle, v_segments, v_reason,
      v_region, v_counted, v_unknown, v_adjusted
    ) on conflict (event_id, ts) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      v_duplicates := v_duplicates + 1;
    else
      v_accepted := v_accepted + 1;
    end if;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_duplicates, 'rejected', v_rejected, 'received', v_count);
end;
$fn$;

revoke all on function public.tomrade_ingest_analytics(jsonb) from public, anon, authenticated;
grant execute on function public.tomrade_ingest_analytics(jsonb) to anon, authenticated;

-- The events that came before their registry: an action that registry counts
-- as a use was stored uncounted. Elsewhere `counted` is fixed when an event
-- arrives and a later registry change never rewrites history; these are the
-- exception, since no registry had judged them yet. Only false turns true, and
-- each day touched is rolled up again (the rollup rewrites a day whole).
do $backfill$
declare
  v_days date[];
  v_day date;
begin
  with flipped as (
    update public.tomrade_analytics_event e
       set counted = true
      from public.tomrade_analytics_registry r
     where e.event = 'feature.activate'
       and not e.counted
       and r.registry = e.registry
       and r.feature_id = e.feature_id
       and r.action = e.action
       and r.counted
    returning (e.ts at time zone 'utc')::date as day
  )
  select array_agg(distinct day order by day) into v_days from flipped;
  foreach v_day in array coalesce(v_days, '{}') loop
    perform public.tomrade_analytics_aggregate(v_day, v_day);
  end loop;
end;
$backfill$;

commit;
