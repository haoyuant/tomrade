-- One anonymous id is held to sixty batches an hour, but anyone can mint a new
-- id per batch. This caps how many ids ingest meets for the first time in an
-- hour, across everyone: past the cap a new id's batch is refused with 429, and
-- the client sends it again later, so a real install's events arrive late
-- rather than never. Ids already seen are untouched. The default is far above
-- today's installs; a deployment can move it:
--
--   alter database postgres set tomrade.analytics_new_installs_per_hour = 2000;
begin;

create table public.tomrade_analytics_new_installs (
  hour timestamptz primary key,
  installs integer not null
);
alter table public.tomrade_analytics_new_installs enable row level security;
revoke all on public.tomrade_analytics_new_installs from public, anon, authenticated;

-- A refused batch rolls its count back, so the hour stays at the cap.
create function public.tomrade_analytics_count_new_install()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_hour timestamptz := date_trunc('hour', now(), 'UTC');
  v_cap integer := coalesce(nullif(current_setting('tomrade.analytics_new_installs_per_hour', true), '')::integer, 500);
  v_installs integer;
begin
  insert into public.tomrade_analytics_new_installs (hour, installs) values (v_hour, 1)
  on conflict (hour) do update set installs = public.tomrade_analytics_new_installs.installs + 1
  returning installs into v_installs;
  if v_installs > v_cap then
    raise exception 'too many new installs this hour' using errcode = 'PT429';
  end if;
  delete from public.tomrade_analytics_new_installs where hour < v_hour - interval '2 days';
  return null;
end;
$fn$;
revoke all on function public.tomrade_analytics_count_new_install() from public, anon, authenticated;

-- After insert only: ingest's upsert of an id it already has is an update.
create trigger tomrade_analytics_count_new_install
  after insert on public.tomrade_analytics_rate
  for each row execute function public.tomrade_analytics_count_new_install();

commit;
