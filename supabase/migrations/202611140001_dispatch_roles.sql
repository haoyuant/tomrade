-- A dispatch may name the project's role the ticket is worked as, and a machine that took a request
-- and never started it no longer holds it for good.
--
-- The role is an id and nothing more: what the role says travels with the project's folder, never
-- through here. A machine that claimed a request says it is still at it while it gets the work going;
-- one that stops before the work starts puts the request back, and one that goes quiet for
-- `stale` loses its claim to the next machine the request is for. A request that is running is never
-- taken over: losing touch with a machine is no proof that its work stopped.
begin;

create or replace function public.tomrade_create_dispatch(p_from text, p_to text, p_platform text, p_project text, p_key text, p_title text, p_wish jsonb, p_ttl_seconds integer default 86400) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_is_device(actor, p_from) then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  if p_to is not null and (p_to = p_from or not public.tomrade_is_device(actor, p_to)) then raise exception 'No such device' using errcode = 'P0002'; end if;
  -- Explicit allowlist: an agent's id, a permission mode's name and a role's id, nothing else.
  if p_wish is null or jsonb_typeof(p_wish) <> 'object' or (p_wish - array['engine','permissionMode','role']) <> '{}'::jsonb
    or (p_wish ? 'engine' and (jsonb_typeof(p_wish->'engine') <> 'string' or p_wish->>'engine' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
    or (p_wish ? 'permissionMode' and (jsonb_typeof(p_wish->'permissionMode') <> 'string' or p_wish->>'permissionMode' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'))
    or (p_wish ? 'role' and (jsonb_typeof(p_wish->'role') <> 'string' or p_wish->>'role' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'))
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

-- How long a machine that took a request may say nothing before the request is on offer again.
create function public.tomrade_dispatch_stale() returns interval
language sql immutable set search_path = '' as $$ select interval '5 minutes' $$;

-- Takes a request for a machine: the one it names, or one of the platform it names. One still waiting
-- is taken; so is one another machine took and went quiet on before the work started. Null when it is
-- not on offer — taken a moment earlier, started, cancelled, or run out.
create or replace function public.tomrade_claim_dispatch(p_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype; platform text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select facts->>'platform' into platform from public.tomrade_devices where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  update public.tomrade_dispatches set state = 'accepted', claimed_by = p_device, updated_at = now()
    where id = p_id and user_id = actor and expires_at > now() and from_device <> p_device
      and (state = 'queued' or (state = 'accepted' and updated_at < now() - public.tomrade_dispatch_stale()))
      and (to_device = p_device or (to_device is null and to_platform = platform))
    returning * into saved;
  if not found then return null; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

-- The taking machine says how it goes: accepted → running → done, or refused with why. While it gets
-- the work going it may say `accepted` again, which keeps its claim; before the work starts it may put
-- the request back (`queued`) for whoever it is for. The machine a request names may also refuse it
-- without taking it.
create or replace function public.tomrade_update_dispatch(p_id uuid, p_device text, p_state text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_state is null or p_state not in ('queued', 'accepted', 'running', 'done', 'refused') then raise exception 'Invalid dispatch state' using errcode = '22023'; end if;
  update public.tomrade_dispatches set state = p_state, updated_at = now(),
      reason = case when p_state in ('queued', 'accepted') then null else left(p_reason, 300) end,
      claimed_by = case when p_state = 'queued' then null else coalesce(claimed_by, p_device) end
    where id = p_id and user_id = actor and (
      (claimed_by = p_device and ((state = 'accepted' and p_state in ('queued', 'accepted', 'running', 'refused', 'done')) or (state = 'running' and p_state = 'done')))
      or (state = 'queued' and to_device = p_device and p_state = 'refused'))
    returning * into saved;
  if not found then raise exception 'This dispatch cannot go to % from here', p_state using errcode = 'P0002'; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

revoke all on function public.tomrade_dispatch_stale() from public, anon, authenticated;

commit;
