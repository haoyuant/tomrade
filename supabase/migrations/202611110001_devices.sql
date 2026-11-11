-- The machines signed in to an account: one row per machine, keyed by the id the machine gave itself.
-- A row says what the machine can do (platform, version, coding agents, git, which repositories it has
-- a checkout of), never where anything is on its disk and never a credential. Whether a machine is
-- online is Realtime Presence, not a column: a row is written when what it says changes.
begin;

create table public.tomrade_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  name text not null check (length(name) between 1 and 80),
  facts jsonb not null default '{}'::jsonb,
  -- Set when the person removed it from another machine: it stays out until someone signs in on it again.
  removed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.tomrade_devices enable row level security;
revoke all on public.tomrade_devices from anon, authenticated;
grant select on public.tomrade_devices to authenticated;
create policy own_devices on public.tomrade_devices for select to authenticated using (user_id = (select auth.uid()));

-- Explicit allowlists: a field this does not name, a local path or a credential is refused, not stored.
create function public.tomrade_device_facts_ok(p_facts jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare agent jsonb; repo jsonb;
begin
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or length(p_facts::text) > 65536
    or (p_facts - array['platform','arch','version','git','agents','repos']) <> '{}'::jsonb
    or not (p_facts ?& array['platform','arch','version','git','agents','repos'])
    or jsonb_typeof(p_facts->'platform') <> 'string' or p_facts->>'platform' !~ '^[a-z0-9]{1,16}$'
    or jsonb_typeof(p_facts->'arch') <> 'string' or p_facts->>'arch' !~ '^[a-z0-9_]{1,16}$'
    or jsonb_typeof(p_facts->'version') <> 'string' or p_facts->>'version' !~ '^[0-9A-Za-z.+-]{1,40}$'
    or jsonb_typeof(p_facts->'git') <> 'boolean'
    or jsonb_typeof(p_facts->'agents') <> 'array' or jsonb_array_length(p_facts->'agents') > 32
    or jsonb_typeof(p_facts->'repos') <> 'array' or jsonb_array_length(p_facts->'repos') > 500
  then return false; end if;
  for agent in select * from jsonb_array_elements(p_facts->'agents') loop
    if jsonb_typeof(agent) <> 'object' or (agent - array['id','title','ready']) <> '{}'::jsonb
      or not (agent ?& array['id','title','ready'])
      or jsonb_typeof(agent->'id') <> 'string' or agent->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      or jsonb_typeof(agent->'title') <> 'string' or agent->>'title' !~ '^[^/\\]{1,80}$'
      or jsonb_typeof(agent->'ready') <> 'boolean'
    then return false; end if;
  end loop;
  for repo in select * from jsonb_array_elements(p_facts->'repos') loop
    -- A remote on a server, as `scheme://host/path` or `user@host:path`: no folder, no file URL, no password.
    if jsonb_typeof(repo) <> 'string' or length(repo #>> '{}') > 512 or (repo #>> '{}') ~ '\s'
      or (repo #>> '{}') ~* '^file:' or (repo #>> '{}') ~ '://[^/@]*:[^/@]*@'
      or not ((repo #>> '{}') ~* '^[a-z][a-z0-9+.-]*://[^/]+/.+' or (repo #>> '{}') ~ '^([^@/:\\]+@)?[^/:\\]{2,}:[^/\\].*')
    then return false; end if;
  end loop;
  return true;
end;
$$;

create function public.tomrade_device_json(d public.tomrade_devices) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('device_id', d.device_id, 'name', d.name, 'facts', d.facts,
    'last_seen_at', d.last_seen_at, 'updated_at', d.updated_at)
$$;

-- A machine says what it is. Its name is taken only when the row is new or was removed: afterwards the
-- name is the account's, changed with tomrade_rename_device from any of its machines.
-- `p_rejoin`: someone signed in on this machine since it last registered, which lets a removed one back.
create function public.tomrade_register_device(p_device text, p_name text, p_facts jsonb, p_rejoin boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); old public.tomrade_devices%rowtype; saved public.tomrade_devices%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{4,64}$' or p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Invalid device' using errcode = '22023';
  end if;
  if not public.tomrade_device_facts_ok(p_facts) then raise exception 'Invalid device fields' using errcode = '22023'; end if;
  select * into old from public.tomrade_devices where user_id = actor and device_id = p_device for update;
  if found and old.removed_at is not null and not coalesce(p_rejoin, false) then
    return jsonb_build_object('state', 'removed');
  end if;
  insert into public.tomrade_devices as d (user_id, device_id, name, facts) values (actor, p_device, btrim(p_name), p_facts)
    on conflict (user_id, device_id) do update set
      facts = excluded.facts, removed_at = null, last_seen_at = now(), updated_at = now(),
      name = case when d.removed_at is null then d.name else excluded.name end
    returning * into saved;
  return jsonb_build_object('state', 'registered', 'device', public.tomrade_device_json(saved));
end;
$$;

create function public.tomrade_rename_device(p_device text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then raise exception 'Invalid device' using errcode = '22023'; end if;
  update public.tomrade_devices set name = btrim(p_name), updated_at = now()
    where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'No such device' using errcode = 'P0002'; end if;
end;
$$;

-- What the machine said about itself goes with it; the row stays as the mark that keeps it out.
create function public.tomrade_remove_device(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.tomrade_devices set removed_at = now(), facts = '{}'::jsonb, updated_at = now()
    where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'No such device' using errcode = 'P0002'; end if;
end;
$$;

-- Stamped as a machine comes online and as it leaves, so one that is off still says when it was last here.
create function public.tomrade_device_seen(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.tomrade_devices set last_seen_at = now()
    where user_id = actor and device_id = p_device and removed_at is null;
end;
$$;

-- For the pricing decision: how many accounts have more than one machine. Not for the API roles.
create function public.tomrade_multi_device_accounts() returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from (
    select user_id from public.tomrade_devices where removed_at is null group by user_id having count(*) > 1
  ) accounts
$$;

revoke all on function public.tomrade_device_facts_ok(jsonb), public.tomrade_device_json(public.tomrade_devices),
  public.tomrade_register_device(text, text, jsonb, boolean), public.tomrade_rename_device(text, text),
  public.tomrade_remove_device(text), public.tomrade_device_seen(text), public.tomrade_multi_device_accounts()
  from public, anon, authenticated;
grant execute on function public.tomrade_register_device(text, text, jsonb, boolean), public.tomrade_rename_device(text, text),
  public.tomrade_remove_device(text), public.tomrade_device_seen(text) to authenticated;

-- Presence runs on a private channel named after the account: only its own machines may join or be seen there.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $policy$
      create policy tomrade_devices_presence_read on realtime.messages for select to authenticated
      using (extension = 'presence' and realtime.topic() = 'tomrade-devices:' || (select auth.uid())::text)
    $policy$;
    execute $policy$
      create policy tomrade_devices_presence_write on realtime.messages for insert to authenticated
      with check (extension = 'presence' and realtime.topic() = 'tomrade-devices:' || (select auth.uid())::text)
    $policy$;
  end if;
end;
$$;

commit;
