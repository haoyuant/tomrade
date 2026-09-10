-- Phase 1: account-owned Hub metadata only. Project content stays in .tomrade/.
begin;

create table public.tomrade_hubs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'Personal Hub',
  created_at timestamptz not null default now()
);
create table public.tomrade_hub_members (
  hub_id uuid not null references public.tomrade_hubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (hub_id, user_id)
);
-- Typed metadata records: the value is a project reference, repository identity,
-- or the Hub's single user-settings document. No local paths, credentials,
-- issues or history.
create table public.tomrade_hub_records (
  hub_id uuid not null references public.tomrade_hubs(id) on delete cascade,
  kind text not null check (kind in ('project', 'repo', 'preference')),
  key text not null check (length(key) between 1 and 2048),
  value jsonb,
  version bigint not null check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (hub_id, kind, key),
  constraint hub_record_shape check (
    value is null or
    (kind = 'preference' and key = 'settings' and jsonb_typeof(value) = 'object'
      and value->>'v' = '1' and jsonb_typeof(value->'sections') = 'object') or
    (kind = 'repo' and jsonb_typeof(value) = 'object' and value ?& array['remote','name']) or
    (kind = 'project' and jsonb_typeof(value) = 'object' and value ?& array['id','name','keyPrefix'])
  )
);
-- Receipts make a request whose response was lost safe to retry after restart.
create table public.tomrade_hub_receipts (
  hub_id uuid not null references public.tomrade_hubs(id) on delete cascade,
  mutation_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (hub_id, mutation_id)
);

alter table public.tomrade_hubs enable row level security;
alter table public.tomrade_hub_members enable row level security;
alter table public.tomrade_hub_records enable row level security;
alter table public.tomrade_hub_receipts enable row level security;
revoke all on public.tomrade_hubs, public.tomrade_hub_members, public.tomrade_hub_records, public.tomrade_hub_receipts from anon, authenticated;
grant select on public.tomrade_hubs, public.tomrade_hub_members, public.tomrade_hub_records to authenticated;
create policy own_membership on public.tomrade_hub_members for select to authenticated using (user_id = (select auth.uid()));
create policy member_hubs on public.tomrade_hubs for select to authenticated using (
  exists (select 1 from public.tomrade_hub_members m where m.hub_id = id and m.user_id = (select auth.uid()))
);
create policy member_records on public.tomrade_hub_records for select to authenticated using (
  exists (select 1 from public.tomrade_hub_members m where m.hub_id = tomrade_hub_records.hub_id and m.user_id = (select auth.uid()))
);

create function public.tomrade_ensure_hub() returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); result uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.tomrade_hubs(owner_id) values (actor)
    on conflict (owner_id) do update set owner_id = excluded.owner_id returning id into result;
  insert into public.tomrade_hub_members(hub_id, user_id, role) values (result, actor, 'owner') on conflict do nothing;
  return result;
end;
$$;

create function public.tomrade_mutate_hub(p_hub uuid, p_mutation jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); op_id uuid := (p_mutation->>'id')::uuid;
  op_kind text := p_mutation->>'kind'; op_key text := p_mutation->>'key';
  base bigint := (p_mutation->>'base_version')::bigint;
  old public.tomrade_hub_records%rowtype; receipt public.tomrade_hub_receipts%rowtype;
  next_value jsonb := nullif(p_mutation->'value', 'null'::jsonb); result jsonb;
begin
  if actor is null or not exists (
    select 1 from public.tomrade_hub_members where hub_id = p_hub and user_id = actor and role = 'owner'
  ) then raise exception 'Hub write denied' using errcode = '42501'; end if;
  -- Serialize writes to this small metadata set, including two concurrent creates.
  perform 1 from public.tomrade_hubs where id = p_hub for update;
  select * into receipt from public.tomrade_hub_receipts where hub_id = p_hub and mutation_id = op_id;
  if found then
    if receipt.user_id <> actor or receipt.request <> p_mutation then
      raise exception 'Mutation id reused with a different request' using errcode = '22023';
    end if;
    return receipt.result;
  end if;
  if op_id is null or op_kind not in ('project', 'repo', 'preference') or op_kind is null
    or op_key is null or length(op_key) not between 1 and 2048 or base is null or base < 0
    or not (p_mutation ? 'value') or (op_kind = 'preference' and op_key <> 'settings') then
    raise exception 'Invalid Hub mutation' using errcode = '22023';
  end if;
  -- Explicit allowlists also protect against accidentally exporting catalog paths.
  if next_value is not null and (
    jsonb_typeof(next_value) <> 'object' or
    (op_kind = 'project' and (next_value - array['id','name','keyPrefix','remote','hint','updatedAt']) <> '{}'::jsonb) or
    (op_kind = 'repo' and (next_value - array['remote','name']) <> '{}'::jsonb) or
    (op_kind = 'preference' and (
      (next_value - array['v','sections']) <> '{}'::jsonb
      or next_value->>'v' <> '1'
      or jsonb_typeof(next_value->'sections') <> 'object'
    ))
  ) then raise exception 'Invalid Hub record fields' using errcode = '22023'; end if;
  select * into old from public.tomrade_hub_records where hub_id = p_hub and kind = op_kind and key = op_key;
  if coalesce(old.version, 0) <> base then
    return jsonb_build_object('ok', false, 'record', jsonb_build_object(
      'kind', op_kind, 'key', op_key, 'value', old.value, 'version', coalesce(old.version, 0)));
  end if;
  insert into public.tomrade_hub_records(hub_id, kind, key, value, version)
    values (p_hub, op_kind, op_key, next_value, base + 1)
    on conflict (hub_id, kind, key) do update set value = excluded.value, version = excluded.version, updated_at = now();
  result := jsonb_build_object('ok', true, 'record', jsonb_build_object(
    'kind', op_kind, 'key', op_key, 'value', next_value, 'version', base + 1));
  insert into public.tomrade_hub_receipts(hub_id, mutation_id, user_id, request, result) values (p_hub, op_id, actor, p_mutation, result);
  return result;
end;
$$;
revoke all on function public.tomrade_ensure_hub(), public.tomrade_mutate_hub(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.tomrade_ensure_hub(), public.tomrade_mutate_hub(uuid, jsonb) to authenticated;
commit;
