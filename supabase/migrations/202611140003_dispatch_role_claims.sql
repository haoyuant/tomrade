-- A request that carries a role is given only to a machine that knows roles.
--
-- An app from before roles reads nothing of a request's role: it would work the ticket by its own
-- limit and with any agent, and the role's limit and words would be dropped without a word. Such an
-- app claims with two arguments; one that knows roles says so with the third. Without it, a request
-- with a role stays as it is when it is for any machine of a platform — another can take it — and is
-- refused when it is addressed to that machine, so the one that asked reads why. Requests without a
-- role are claimed as before, by either.
begin;

drop function public.tomrade_claim_dispatch(uuid, text);

create function public.tomrade_claim_dispatch(p_id uuid, p_device text, p_roles boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); saved public.tomrade_dispatches%rowtype; platform text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select facts->>'platform' into platform from public.tomrade_devices where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'This machine is not one of the account''s devices' using errcode = '42501'; end if;
  if not coalesce(p_roles, false) then
    update public.tomrade_dispatches set state = 'refused', reason = 'outdated', updated_at = now()
      where id = p_id and user_id = actor and wish ? 'role' and state = 'queued' and approved and expires_at > now() and to_device = p_device;
    if found or exists (select 1 from public.tomrade_dispatches where id = p_id and user_id = actor and wish ? 'role') then return null; end if;
  end if;
  update public.tomrade_dispatches set state = 'accepted', claimed_by = p_device, updated_at = now()
    where id = p_id and user_id = actor and approved and expires_at > now() and from_device <> p_device
      and (state = 'queued' or (state = 'accepted' and updated_at < now() - public.tomrade_dispatch_stale()))
      and (to_device = p_device or (to_device is null and to_platform = platform))
    returning * into saved;
  if not found then return null; end if;
  return public.tomrade_dispatch_json(saved);
end;
$$;

revoke all on function public.tomrade_claim_dispatch(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.tomrade_claim_dispatch(uuid, text, boolean) to authenticated;

commit;
