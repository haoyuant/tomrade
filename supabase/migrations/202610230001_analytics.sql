-- Anonymous usage analytics: what arrived, what it is worth, and how long it stays.
--
-- A client sends only what `packages/analytics` already validated: three event
-- kinds, a random identifier, a feature id, an action, durations and times.
-- Nothing here has a column for a person, a project, a file, a title or an IP;
-- the region is inferred at the edge and only its five-way bucket is kept.
--
-- Written through tomrade_ingest_analytics() only. The dashboard and the
-- retention job use the service role, which bypasses these grants.
begin;

-- The feature registry the server validates against. It mirrors
-- packages/analytics/src/features.ts; a release that adds a feature ships a
-- migration that adds its rows and raises the registry version.
create table public.tomrade_analytics_registry (
  registry smallint not null,
  feature_id text not null,
  action text not null,
  counted boolean not null default false,
  dims text[],
  primary key (registry, feature_id, action)
);

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims) values
  (1, 'project.list', 'open', true, null),
  (1, 'project.list', 'create', true, null),
  (1, 'project.list', 'import', true, null),
  (1, 'backlog.board', 'open', true, null),
  (1, 'backlog.lane', 'lane_on', false, null),
  (1, 'backlog.lane', 'lane_off', false, null),
  (1, 'backlog.lane', 'lane_collapse', false, null),
  (1, 'backlog.table', 'open', true, null),
  (1, 'backlog.graph', 'open', true, null),
  (1, 'backlog.issue', 'open', true, null),
  (1, 'backlog.create', 'create', true, array['quick','form','template']),
  (1, 'backlog.view', 'view_save', false, null),
  (1, 'backlog.view', 'view_switch', false, null),
  (1, 'backlog.view', 'query_change', false, null),
  (1, 'backlog.search', 'search_query', false, null),
  (1, 'backlog.search', 'command_run', false, null),
  (1, 'code.link', 'start', true, null),
  (1, 'code.link', 'open_pr', false, null),
  (1, 'code.link', 'merge', true, null),
  (1, 'code.link', 'open_worktree', false, null),
  (1, 'code.terminal', 'open', true, null),
  (1, 'code.terminal', 'session_new', true, null),
  (1, 'agent.chat', 'open', true, null),
  (1, 'agent.chat', 'message_sent', false, array['loop','scripted','claude-code','codex','pi','cursor','dsh','hermes','opencode','workbuddy']),
  (1, 'files.browse', 'open', true, null),
  (1, 'files.browse', 'upload', true, null),
  (1, 'files.browse', 'create', true, null),
  (1, 'files.browse', 'restore', false, null),
  (1, 'notes.editor', 'open', true, null),
  (1, 'notes.editor', 'create', true, null),
  (1, 'notes.editor', 'follow_link', false, null),
  (1, 'routines.list', 'open', true, null),
  (1, 'routines.list', 'create', true, null),
  (1, 'routines.list', 'run_now', true, null),
  (1, 'inbox.triage', 'open', true, null),
  (1, 'inbox.triage', 'accept', true, null),
  (1, 'inbox.triage', 'dismiss', true, null),
  (1, 'im', 'ticket_created', true, array['feishu','dingtalk','wecom','slack','discord','other']),
  (1, 'im', 'reply', true, array['feishu','dingtalk','wecom','slack','discord','other']),
  (1, 'plugins.manage', 'open', true, null),
  (1, 'plugins.manage', 'enable', true, null),
  (1, 'plugins.manage', 'disable', true, null),
  (1, 'plugins.studio', 'open', true, null),
  (1, 'plugins.studio', 'build', true, null),
  (1, 'plugins.studio', 'test', true, null),
  (1, 'plugins.store', 'open', true, null),
  (1, 'plugins.store', 'install', true, null),
  (1, 'plugins.store', 'update', true, null),
  (1, 'settings', 'open', true, null),
  (1, 'settings', 'change', false, array['theme','language','customThemes','themeAutomation','notifications','updates','account','agent','mcp','plugins','im','analytics']),
  (1, 'pet.companion', 'open', true, null),
  (1, 'pet.companion', 'toggle', false, null),
  (1, 'pet.companion', 'interact', false, null),
  (1, 'doctor', 'open', true, null),
  (1, 'doctor', 'run_check', true, null),
  (1, 'doctor', 'send_report', false, null),
  (1, 'plugin.pomodoro', 'open', true, null),
  (1, 'plugin.pomodoro', 'start', true, null),
  (1, 'plugin.pomodoro', 'complete', true, null),
  (1, 'plugin.community', 'open', true, null),
  (1, 'onboarding', 'tour_start', false, null),
  (1, 'onboarding', 'tour_finish', false, null),
  (1, 'onboarding', 'hint_dismiss', false, null);

-- One row per accepted event. Monthly partitions keep the retention job to a
-- DROP, and the primary key carries ts because a partition is keyed on it.
create table public.tomrade_analytics_event (
  event_id uuid not null,
  schema smallint not null,
  registry smallint not null,
  event text not null check (event in ('app.start', 'feature.activate', 'feature.session')),
  anon_id text not null check (anon_id ~ '^[a-z2-7]{26}$'),
  install_seq bigint not null check (install_seq >= 1),
  ts timestamptz not null,
  received_at timestamptz not null default now(),
  client text not null check (client ~ '^[0-9]+\.[0-9]+\.[0-9]+'),
  platform text not null check (platform in ('macos', 'windows', 'linux')),
  feature_id text,
  action text,
  dim text,
  session_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  active_ms integer check (active_ms between 0 and 86400000),
  idle_ms integer check (idle_ms >= 0),
  segments smallint check (segments >= 1),
  end_reason text check (end_reason in ('switch', 'blur', 'idle', 'lock', 'suspend', 'quit', 'crash', 'cap')),
  region text not null check (region in ('cn', 'apac', 'eu', 'na', 'other')),
  counted boolean not null default false,
  unknown_feature boolean not null default false,
  time_adjusted boolean not null default false,
  primary key (event_id, ts)
) partition by range (ts);

create index tomrade_analytics_event_feature_ts on public.tomrade_analytics_event (feature_id, ts);
create index tomrade_analytics_event_anon_ts on public.tomrade_analytics_event (anon_id, ts);
create index tomrade_analytics_event_region_ts on public.tomrade_analytics_event (region, ts);

-- Monthly partitions are made on demand by ingest, so a retried batch from an
-- older month still lands.
create function public.tomrade_analytics_ensure_month(p_ts timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_start timestamptz := date_trunc('month', p_ts at time zone 'utc') at time zone 'utc';
  v_name text := 'tomrade_analytics_event_' || to_char(v_start at time zone 'utc', 'YYYY_MM');
begin
  execute format(
    'create table if not exists public.%I partition of public.tomrade_analytics_event for values from (%L) to (%L)',
    v_name, v_start, v_start + interval '1 month'
  );
end;
$fn$;

-- The five-way bucket, read from whatever the edge put in the headers and
-- thrown away after this call. No country and no IP is ever written.
create function public.tomrade_analytics_region()
returns text
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_country text;
  v_headers jsonb;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  v_country := upper(coalesce(
    v_headers ->> 'cf-ipcountry',
    v_headers ->> 'x-vercel-ip-country',
    v_headers ->> 'x-tomrade-country',
    ''
  ));
  if length(v_country) <> 2 then return 'other'; end if;
  return case
    when v_country = 'CN' then 'cn'
    when v_country in ('JP','KR','SG','AU','NZ','IN','ID','MY','TH','VN','PH','TW','HK','MO','BD','LK','PK','MN','KH','LA','MM','BN','NP','BT','MV') then 'apac'
    when v_country in ('US','CA','MX') then 'na'
    when v_country in ('GB','CH','NO','IS','LI','AD','MC','SM','VA') then 'eu'
    when v_country in ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE') then 'eu'
    else 'other'
  end;
exception when others then
  return 'other';
end;
$fn$;

-- Batches per anonymous id, by arrival. Its window resets in place; no IP is kept.
create table public.tomrade_analytics_rate (
  anon_id text primary key,
  window_start timestamptz not null,
  batches integer not null
);

-- What the dashboard reads: one row per feature, day and coarse region.
create table public.tomrade_analytics_actor_daily (
  day date not null,
  region text not null,
  feature_id text not null,
  anon_id text not null,
  primary key (day, region, feature_id, anon_id)
);
create index tomrade_analytics_actor_daily_day on public.tomrade_analytics_actor_daily (day);

create table public.tomrade_analytics_feature_daily (
  day date not null,
  region text not null,
  feature_id text not null,
  client_minor text not null,
  sessions integer not null default 0,
  active_ms bigint not null default 0,
  actors integer not null default 0,
  primary key (day, region, feature_id, client_minor)
);

create table public.tomrade_analytics_action_daily (
  day date not null,
  region text not null,
  feature_id text not null,
  action text not null,
  dim text not null default '',
  client_minor text not null,
  events integer not null default 0,
  counted_events integer not null default 0,
  actors integer not null default 0,
  primary key (day, region, feature_id, action, dim, client_minor)
);

-- The one way in. Strict in both directions: an undeclared field rejects the
-- batch, an unknown action rejects its row, an unregistered dim is dropped but
-- the event is kept, and an event under a feature this server has not learned
-- yet is kept and flagged.
create function public.tomrade_ingest_analytics(p_batch jsonb)
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
      select not exists (select 1 from public.tomrade_analytics_registry r where r.registry = v_registry and r.feature_id = v_feature)
        into v_unknown;
    end if;

    if v_event_name = 'feature.activate' then
      select r.counted, r.dims into v_counted, v_dims
        from public.tomrade_analytics_registry r
       where r.registry = v_registry and r.feature_id = v_feature and r.action = v_action;
      if not found then
        if v_unknown then
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

-- Nothing reads these with the public key; the dashboard uses the service role.
alter table public.tomrade_analytics_registry enable row level security;
alter table public.tomrade_analytics_event enable row level security;
alter table public.tomrade_analytics_actor_daily enable row level security;
alter table public.tomrade_analytics_feature_daily enable row level security;
alter table public.tomrade_analytics_action_daily enable row level security;
alter table public.tomrade_analytics_rate enable row level security;
revoke all on public.tomrade_analytics_registry from public, anon, authenticated;
revoke all on public.tomrade_analytics_event from public, anon, authenticated;
revoke all on public.tomrade_analytics_actor_daily from public, anon, authenticated;
revoke all on public.tomrade_analytics_feature_daily from public, anon, authenticated;
revoke all on public.tomrade_analytics_action_daily from public, anon, authenticated;
revoke all on public.tomrade_analytics_rate from public, anon, authenticated;


-- The retention job: whole monthly event partitions past 180 days, actor rows
-- past 180, aggregates past 25 months, and rate windows nobody needs. The
-- dashboard disables retention and deduplicated activity past 180 days.
create function public.tomrade_analytics_retention()
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

  return jsonb_build_object('partitions', v_parts, 'actors', v_actors, 'features', v_features, 'actions', v_actions, 'rates', v_rates);
end;
$fn$;

revoke all on function public.tomrade_analytics_retention() from public, anon, authenticated;

-- Run nightly from the deployment's scheduler; see docs/analytics.md.
-- select cron.schedule('tomrade-analytics-retention', '17 3 * * *', $select public.tomrade_analytics_retention()$);

commit;
