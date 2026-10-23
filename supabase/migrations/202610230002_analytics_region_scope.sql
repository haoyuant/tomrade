-- Two deployments, one contract: a mainland deployment keeps only Chinese
-- detail and a global one keeps everything else. The setting is made once, by
-- the deployment, not per request:
--
--   alter database postgres set tomrade.analytics_scope = 'cn';
--   alter database postgres set tomrade.analytics_scope = 'global';
--
-- Unset (a test or a single-deployment install) accepts both. A row whose
-- inferred region belongs on the other side is refused with HTTP 421, which
-- tells an operator the endpoint or the edge is misrouted. The client drops
-- that batch and carries on; nothing crosses and nothing blocks the person.
begin;

create function public.tomrade_analytics_scope_allows(p_region text)
returns boolean
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_scope text := current_setting('tomrade.analytics_scope', true);
begin
  if v_scope is null or v_scope = '' then return true; end if;
  if v_scope = 'cn' then return p_region = 'cn'; end if;
  if v_scope = 'global' then return p_region <> 'cn'; end if;
  return true;
end;
$fn$;

create function public.tomrade_analytics_scope_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not public.tomrade_analytics_scope_allows(new.region) then
    raise exception 'this deployment does not accept % detail', new.region using errcode = 'PT421';
  end if;
  return new;
end;
$fn$;

create trigger tomrade_analytics_event_scope
  before insert on public.tomrade_analytics_event
  for each row execute function public.tomrade_analytics_scope_guard();

-- Aggregate tables hold no identifier, so a row that slipped in with the wrong
-- scope is harmless; the event guard is the boundary that matters.

commit;
