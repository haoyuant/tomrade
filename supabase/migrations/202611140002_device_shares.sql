-- A machine its owner lets one other person send tickets to.
--
-- The owner names the other person by the address of their account, on the machine itself. That person
-- then sees the machine (its name, platform, agents, which projects it takes, how far a ticket of theirs
-- may go, when it was last seen: no path, no repository, no session) and may ask it to work a ticket.
-- Unless the owner said otherwise for that person, each such request waits for the owner's yes on that
-- machine: the work runs with the owner's own agent, so the owner is the one who starts it. Taking the
-- share back cancels what that person still has going there.
begin;

create table public.tomrade_device_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  device_id text not null,
  -- The other person, by the address of their account, in lower case. Kept whether or not an account
  -- has that address: saying which would tell anyone who asks which addresses are users.
  guest_email text not null check (guest_email = lower(guest_email) and guest_email ~ '^[^\s@]{1,64}@[^\s@]{1,190}$'),
  -- The most a ticket of theirs may do without asking; the machine's own limit and the role's still hold.
  ceiling text not null default 'edits' check (ceiling in ('read', 'ask', 'edits', 'full')),
  -- False: each ticket of theirs waits for the owner's yes on the machine.
  auto boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, device_id, guest_email),
  foreign key (owner_id, device_id) references public.tomrade_devices(user_id, device_id) on delete cascade
);
create index tomrade_device_shares_guest on public.tomrade_device_shares (guest_email);
-- Read and written through the functions below alone.
alter table public.tomrade_device_shares enable row level security;
revoke all on public.tomrade_device_shares from anon, authenticated;

-- A request from another account: who asks, whether the owner has said yes, and how far it may go.
alter table public.tomrade_dispatches
  add column from_user uuid references auth.users(id) on delete cascade,
  add column from_email text,
  -- Whether it was made to wait for the owner's yes: said once, when it is made.
  add column needs_yes boolean not null default false,
  add column approved boolean not null default true,
  add column ceiling text check (ceiling is null or ceiling in ('read', 'ask', 'edits', 'full'));
create index tomrade_dispatches_sent on public.tomrade_dispatches (from_user, updated_at desc) where from_user is not null;
-- The person who asked reads how their own request stands, and nothing else of that account's.
create policy sent_dispatches on public.tomrade_dispatches for select to authenticated using (from_user = (select auth.uid()));

create or replace function public.tomrade_dispatch_json(d public.tomrade_dispatches) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'from_device', d.from_device, 'to_device', d.to_device, 'to_platform', d.to_platform,
    'project_id', d.project_id, 'item_key', d.item_key, 'title', d.title, 'wish', d.wish, 'state', d.state, 'reason', d.reason,
    'claimed_by', d.claimed_by, 'created_at', d.created_at, 'updated_at', d.updated_at, 'expires_at', d.expires_at,
    'from_email', d.from_email, 'needs_yes', d.needs_yes, 'approved', d.approved, 'ceiling', d.ceiling)
$$;

-- The address of the signed-in account, in lower case.
create function public.tomrade_my_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = auth.uid()
$$;

-- What a request may wish for: an agent's id, a permission mode's name and a role's id, nothing else.
create function public.tomrade_dispatch_wish_ok(p_wish jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_wish is not null and jsonb_typeof(p_wish) = 'object' and (p_wish - array['engine','permissionMode','role']) = '{}'::jsonb
    and (not p_wish ? 'engine' or (jsonb_typeof(p_wish->'engine') = 'string' and p_wish->>'engine' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
    and (not p_wish ? 'permissionMode' or (jsonb_typeof(p_wish->'permissionMode') = 'string' and p_wish->>'permissionMode' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'))
    and (not p_wish ? 'role' or (jsonb_typeof(p_wish->'role') = 'string' and p_wish->>'role' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
$$;

-- The owner lets one person send tickets to one of the account's machines, or changes how far theirs may go.
create function public.tomrade_share_device(p_device text, p_email text, p_ceiling text default 'edits', p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); email text := lower(btrim(coalesce(p_email, ''))); saved public.tomrade_device_shares%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_device) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  if email !~ '^[^\s@]{1,64}@[^\s@]{1,190}$' or p_ceiling is null or p_ceiling not in ('read', 'ask', 'edits', 'full') then raise exception 'Invalid share' using errcode = '22023'; end if;
  if email = public.tomrade_my_email() then raise exception 'That is this account''s own address' using errcode = '22023'; end if;
  if (select count(*) from public.tomrade_device_shares where owner_id = actor and device_id = p_device and guest_email <> email) >= 20 then
    raise exception 'A machine is shared with at most 20 people' using errcode = '54000';
  end if;
  insert into public.tomrade_device_shares as s (owner_id, device_id, guest_email, ceiling, auto) values (actor, p_device, email, p_ceiling, coalesce(p_auto, false))
    on conflict (owner_id, device_id, guest_email) do update set ceiling = excluded.ceiling, auto = excluded.auto, updated_at = now()
    returning * into saved;
  return jsonb_build_object('email', saved.guest_email, 'ceiling', saved.ceiling, 'auto', saved.auto, 'created_at', saved.created_at);
end;
$$;

-- The owner takes a share back. What that person still has going on the machine is cancelled with it:
-- the machine stops the session it runs for them when it hears.
create function public.tomrade_unshare_device(p_device text, p_email text) returns integer
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); email text := lower(btrim(coalesce(p_email, ''))); gone integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  delete from public.tomrade_device_shares where owner_id = actor and device_id = p_device and guest_email = email;
  get diagnostics gone = row_count;
  update public.tomrade_dispatches set state = 'cancelled', reason = 'unshared', updated_at = now()
    where user_id = actor and to_device = p_device and from_user is not null and from_email = email and state in ('queued', 'accepted', 'running');
  return gone;
end;
$$;

-- The people one of the account's machines is shared with.
create function public.tomrade_device_shares(p_device text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email', s.guest_email, 'ceiling', s.ceiling, 'auto', s.auto, 'created_at', s.created_at) order by s.created_at)
    from public.tomrade_device_shares s where s.owner_id = actor and s.device_id = p_device), '[]'::jsonb);
end;
$$;

-- The machines other people share with the signed-in account, as much as it needs to choose one.
create function public.tomrade_shared_devices() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); email text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  email := public.tomrade_my_email();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'share', s.id, 'owner', (select lower(u.email) from auth.users u where u.id = s.owner_id), 'device_id', d.device_id, 'name', d.name,
      'platform', d.facts->>'platform', 'agents', coalesce(d.facts->'agents', '[]'::jsonb),
      'accept', case when d.facts ? 'accept' then jsonb_build_object('on', d.facts->'accept'->'on', 'projects', d.facts->'accept'->'projects', 'ceiling', d.facts->'accept'->'ceiling') end,
      'ceiling', s.ceiling, 'auto', s.auto, 'last_seen_at', d.last_seen_at) order by d.name, s.id)
    from public.tomrade_device_shares s join public.tomrade_devices d on d.user_id = s.owner_id and d.device_id = s.device_id
    where s.guest_email = email and d.removed_at is null), '[]'::jsonb);
end;
$$;

create or replace function public.tomrade_create_dispatch(p_from text, p_to text, p_platform text, p_project text, p_key text, p_title text, p_wish jsonb, p_ttl_seconds integer default 86400) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_from) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  if p_to is not null and (p_to = p_from or not public.tomrade_is_device(actor, p_to)) then raise exception 'No such device' using errcode = 'P0002'; end if;
  if not public.tomrade_dispatch_wish_ok(p_wish) or p_ttl_seconds is null or p_ttl_seconds not between 60 and 604800 or (p_to is null and p_platform is null)
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

-- A person a machine is shared with asks it to work a ticket. The request joins the owner's queue, for
-- that machine alone, and waits for the owner's yes unless the owner said theirs need none.
create function public.tomrade_create_shared_dispatch(p_share uuid, p_from text, p_project text, p_key text, p_title text, p_wish jsonb, p_ttl_seconds integer default 86400) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); email text; share public.tomrade_device_shares%rowtype; saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_from) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  email := public.tomrade_my_email();
  select s.* into share from public.tomrade_device_shares s join public.tomrade_devices d on d.user_id = s.owner_id and d.device_id = s.device_id
    where s.id = p_share and s.guest_email = email and d.removed_at is null;
  if not found then raise exception 'No such shared device' using errcode = 'P0002'; end if;
  if not public.tomrade_dispatch_wish_ok(p_wish) or p_ttl_seconds is null or p_ttl_seconds not between 60 and 604800
  then raise exception 'Invalid dispatch' using errcode = '22023'; end if;
  update public.tomrade_dispatches set state = 'cancelled', reason = 'expired', updated_at = now()
    where user_id = share.owner_id and project_id = p_project and item_key = p_key and state = 'queued' and expires_at <= now();
  begin
    insert into public.tomrade_dispatches (user_id, from_device, to_device, project_id, item_key, title, wish, expires_at, from_user, from_email, needs_yes, approved, ceiling)
      values (share.owner_id, p_from, share.device_id, p_project, p_key, left(coalesce(p_title, ''), 200), p_wish, now() + make_interval(secs => p_ttl_seconds), actor, email, not share.auto, share.auto, share.ceiling)
      returning * into saved;
  exception when unique_violation then
    raise exception 'This ticket is already sent to a machine' using errcode = '23505';
  end;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- The owner says yes, on the machine the request is for.
create function public.tomrade_approve_dispatch(p_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_device) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  update public.tomrade_dispatches set approved = true, updated_at = now()
    where id = p_id and user_id = actor and to_device = p_device and state = 'queued' and not approved and expires_at > now()
    returning * into saved;
  if not found then raise exception 'This request no longer waits for a yes' using errcode = 'P0002'; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- As before, and only a request the owner has said yes to.
create or replace function public.tomrade_claim_dispatch(p_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype; platform text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select facts->>'platform' into platform from public.tomrade_devices where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  update public.tomrade_dispatches set state = 'accepted', claimed_by = p_device, updated_at = now()
    where id = p_id and user_id = actor and approved and expires_at > now() and from_device <> p_device
      and (state = 'queued' or (state = 'accepted' and updated_at < now() - public.tomrade_dispatch_stale()))
      and (to_device = p_device or (to_device is null and to_platform = platform))
    returning * into saved;
  if not found then return null; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- Any of the owner's machines may take a request back while it is still going; so may the person who asked.
create or replace function public.tomrade_cancel_dispatch(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.tomrade_dispatches set state = 'cancelled', reason = left(p_reason, 300), updated_at = now()
    where id = p_id and (user_id = actor or from_user = actor) and state in ('queued', 'accepted', 'running')
    returning * into saved;
  if not found then raise exception 'This dispatch is no longer going' using errcode = 'P0002'; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

revoke all on function public.tomrade_my_email(), public.tomrade_dispatch_wish_ok(jsonb), public.tomrade_share_device(text, text, text, boolean),
  public.tomrade_unshare_device(text, text), public.tomrade_device_shares(text), public.tomrade_shared_devices(),
  public.tomrade_create_shared_dispatch(uuid, text, text, text, text, jsonb, integer), public.tomrade_approve_dispatch(uuid, text)
  from public, anon, authenticated;
grant execute on function public.tomrade_share_device(text, text, text, boolean), public.tomrade_unshare_device(text, text),
  public.tomrade_device_shares(text), public.tomrade_shared_devices(), public.tomrade_create_shared_dispatch(uuid, text, text, text, text, jsonb, integer),
  public.tomrade_approve_dispatch(uuid, text) to authenticated;

commit;
