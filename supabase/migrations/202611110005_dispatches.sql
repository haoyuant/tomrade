-- Tickets one of an account's machines asks another to work on. A row says which ticket, who asks and
-- who it is for — one machine, or any of a platform — and how the request stands. It carries no code,
-- no prompt and no credential: the ticket travels with its project, and the machine that takes the
-- work uses its own agent, under its own limits.
begin;

create table public.tomrade_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_device text not null,
  -- The machine it is for; null when any machine of `to_platform` may take it.
  to_device text,
  to_platform text check (to_platform is null or to_platform ~ '^[a-z0-9]{1,16}$'),
  project_id text not null check (project_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  item_key text not null check (item_key ~ '^[^\s/\\:]{1,24}-[0-9]{1,9}$'),
  title text not null check (length(title) <= 200),
  -- What the asking machine would like: an agent and a permission mode. The taking machine decides.
  wish jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check (state in ('queued', 'accepted', 'running', 'done', 'refused', 'cancelled')),
  reason text check (reason is null or length(reason) <= 300),
  -- The machine that took it.
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Not taken by then, it is no longer on offer.
  expires_at timestamptz not null,
  check (to_device is not null or to_platform is not null)
);
-- One request at a time per ticket: two machines are never asked to work the same one.
create unique index tomrade_dispatches_live on public.tomrade_dispatches (user_id, project_id, item_key)
  where state in ('queued', 'accepted', 'running');
create index tomrade_dispatches_recent on public.tomrade_dispatches (user_id, updated_at desc);

alter table public.tomrade_dispatches enable row level security;
revoke all on public.tomrade_dispatches from anon, authenticated;
grant select on public.tomrade_dispatches to authenticated;
create policy own_dispatches on public.tomrade_dispatches for select to authenticated using (user_id = (select auth.uid()));

create function public.tomrade_dispatch_json(d public.tomrade_dispatches) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'from_device', d.from_device, 'to_device', d.to_device, 'to_platform', d.to_platform,
    'project_id', d.project_id, 'item_key', d.item_key, 'title', d.title, 'wish', d.wish, 'state', d.state, 'reason', d.reason,
    'claimed_by', d.claimed_by, 'created_at', d.created_at, 'updated_at', d.updated_at, 'expires_at', d.expires_at)
$$;

-- A machine of this account that holds a place: only those send work and take it.
create function public.tomrade_is_device(p_user uuid, p_device text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tomrade_devices where user_id = p_user and device_id = p_device and removed_at is null)
$$;

create function public.tomrade_create_dispatch(p_from text, p_to text, p_platform text, p_project text, p_key text, p_title text, p_wish jsonb, p_ttl_seconds integer default 86400) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_from) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  if p_to is not null and (p_to = p_from or not public.tomrade_is_device(actor, p_to)) then raise exception 'No such device' using errcode = 'P0002'; end if;
  -- Explicit allowlist: an agent's id and a permission mode's name, nothing else.
  if p_wish is null or jsonb_typeof(p_wish) <> 'object' or (p_wish - array['engine','permissionMode']) <> '{}'::jsonb
    or (p_wish ? 'engine' and (jsonb_typeof(p_wish->'engine') <> 'string' or p_wish->>'engine' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
    or (p_wish ? 'permissionMode' and (jsonb_typeof(p_wish->'permissionMode') <> 'string' or p_wish->>'permissionMode' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'))
    or p_ttl_seconds is null or p_ttl_seconds not between 60 and 604800
    or (p_to is null and p_platform is null)
  then raise exception 'Invalid dispatch' using errcode = '22023'; end if;
  -- One that nobody took in time makes room for the next.
  update public.tomrade_dispatches set state = 'cancelled', reason = 'expired', updated_at = now()
    where user_id = actor and project_id = p_project and item_key = p_key and state = 'queued' and expires_at <= now();
  begin
    insert into public.tomrade_dispatches (user_id, from_device, to_device, to_platform, project_id, item_key, title, wish, expires_at)
      values (actor, p_from, p_to, case when p_to is null then p_platform end, p_project, p_key, left(coalesce(p_title, ''), 200), p_wish, now() + make_interval(secs => p_ttl_seconds))
      returning * into saved;
  exception when unique_violation then
    raise exception 'This ticket is already sent to a machine' using errcode = '23505';
  end;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- Takes a request for a machine: the one it names, or one of the platform it names. Null when it is
-- no longer on offer — taken by another machine a moment earlier, cancelled, or run out.
create function public.tomrade_claim_dispatch(p_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype; platform text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select facts->>'platform' into platform from public.tomrade_devices where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  update public.tomrade_dispatches set state = 'accepted', claimed_by = p_device, updated_at = now()
    where id = p_id and user_id = actor and state = 'queued' and expires_at > now() and from_device <> p_device
      and (to_device = p_device or (to_device is null and to_platform = platform))
    returning * into saved;
  if not found then return null; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- The taking machine says how it goes: accepted → running → done, or refused with why. The machine a
-- request names may also refuse it without taking it.
create function public.tomrade_update_dispatch(p_id uuid, p_device text, p_state text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_state is null or p_state not in ('running', 'done', 'refused') then raise exception 'Invalid dispatch state' using errcode = '22023'; end if;
  update public.tomrade_dispatches set state = p_state, reason = left(p_reason, 300), updated_at = now(),
      claimed_by = coalesce(claimed_by, p_device)
    where id = p_id and user_id = actor and (
      (claimed_by = p_device and ((state = 'accepted' and p_state in ('running', 'refused', 'done')) or (state = 'running' and p_state = 'done')))
      or (state = 'queued' and to_device = p_device and p_state = 'refused'))
    returning * into saved;
  if not found then raise exception 'This dispatch cannot go to % from here', p_state using errcode = 'P0002'; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- Any of the account's machines may take a request back while it is still going.
create function public.tomrade_cancel_dispatch(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.tomrade_dispatches set state = 'cancelled', reason = left(p_reason, 300), updated_at = now()
    where id = p_id and user_id = actor and state in ('queued', 'accepted', 'running')
    returning * into saved;
  if not found then raise exception 'This dispatch is no longer going' using errcode = 'P0002'; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

revoke all on function public.tomrade_dispatch_json(public.tomrade_dispatches), public.tomrade_is_device(uuid, text),
  public.tomrade_create_dispatch(text, text, text, text, text, text, jsonb, integer), public.tomrade_claim_dispatch(uuid, text),
  public.tomrade_update_dispatch(uuid, text, text, text), public.tomrade_cancel_dispatch(uuid, text)
  from public, anon, authenticated;
grant execute on function public.tomrade_create_dispatch(text, text, text, text, text, text, jsonb, integer), public.tomrade_claim_dispatch(uuid, text),
  public.tomrade_update_dispatch(uuid, text, text, text), public.tomrade_cancel_dispatch(uuid, text) to authenticated;

commit;
