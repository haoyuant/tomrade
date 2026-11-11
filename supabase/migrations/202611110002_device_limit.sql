-- How many machines an account may register: two for free, more with a subscription.
-- The plans are placeholders until pricing is decided (TOM-988): a row here is what a payment
-- webhook will write, with the service role. Nothing an API role can do adds or changes one, so
-- the limit holds whatever a client build does.
begin;

create table public.tomrade_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Placeholder plan ids; the real tiers replace this check.
  plan text not null check (plan in ('placeholder_plus')),
  -- How many machines the plan allows; null for no limit.
  device_limit integer check (device_limit is null or device_limit >= 0),
  -- Null: until it is taken away.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tomrade_entitlements enable row level security;
revoke all on public.tomrade_entitlements from anon, authenticated;
grant select on public.tomrade_entitlements to authenticated;
create policy own_entitlement on public.tomrade_entitlements for select to authenticated using (user_id = (select auth.uid()));

-- What an account without a subscription gets.
create function public.tomrade_free_device_limit() returns integer
language sql immutable set search_path = '' as $$ select 2 $$;

-- The account's plan and how many machines it allows: `limit` is null when there is none.
create function public.tomrade_device_allowance(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('plan', e.plan, 'limit', e.device_limit)
      from public.tomrade_entitlements e
      where e.user_id = p_user and (e.expires_at is null or e.expires_at > now())),
    jsonb_build_object('plan', 'free', 'limit', public.tomrade_free_device_limit()))
$$;

-- As before, and a machine the account has no room for is told so instead of registered. Machines
-- already registered keep their rows: an account over its limit only cannot add another.
create or replace function public.tomrade_register_device(p_device text, p_name text, p_facts jsonb, p_rejoin boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); old public.tomrade_devices%rowtype; saved public.tomrade_devices%rowtype;
  allowance jsonb; used integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{4,64}$' or p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Invalid device' using errcode = '22023';
  end if;
  if not public.tomrade_device_facts_ok(p_facts) then raise exception 'Invalid device fields' using errcode = '22023'; end if;
  -- One registration at a time per account: two machines racing for the last place cannot both take it.
  perform pg_advisory_xact_lock(hashtextextended('tomrade_devices:' || actor::text, 0));
  select * into old from public.tomrade_devices where user_id = actor and device_id = p_device for update;
  if found and old.removed_at is not null and not coalesce(p_rejoin, false) then
    return jsonb_build_object('state', 'removed');
  end if;
  if not found or old.removed_at is not null then
    allowance := public.tomrade_device_allowance(actor);
    select count(*) into used from public.tomrade_devices where user_id = actor and removed_at is null;
    if allowance->'limit' <> 'null'::jsonb and used >= (allowance->>'limit')::integer then
      return jsonb_build_object('state', 'over_limit', 'limit', allowance->'limit', 'plan', allowance->'plan');
    end if;
  end if;
  insert into public.tomrade_devices as d (user_id, device_id, name, facts) values (actor, p_device, btrim(p_name), p_facts)
    on conflict (user_id, device_id) do update set
      facts = excluded.facts, removed_at = null, last_seen_at = now(), updated_at = now(),
      name = case when d.removed_at is null then d.name else excluded.name end
    returning * into saved;
  return jsonb_build_object('state', 'registered', 'device', public.tomrade_device_json(saved));
end;
$$;

-- For a machine to say what the account has: its plan, the limit, and how many places are taken.
create function public.tomrade_device_plan() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  return public.tomrade_device_allowance(actor) || jsonb_build_object('used',
    (select count(*) from public.tomrade_devices where user_id = actor and removed_at is null));
end;
$$;

revoke all on function public.tomrade_free_device_limit(), public.tomrade_device_allowance(uuid), public.tomrade_device_plan()
  from public, anon, authenticated;
grant execute on function public.tomrade_device_plan() to authenticated;

commit;
