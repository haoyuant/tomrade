-- What each machine is working on, for the account's other machines: the tickets its coding sessions
-- hold and how far an auto run has come. A summary only — no terminal output, no prompt, no path —
-- kept on the machine's own row, so a machine that is off still says what it was last doing, and when.
begin;

alter table public.tomrade_devices
  add column activity jsonb not null default '{}'::jsonb,
  add column activity_at timestamptz;

create function public.tomrade_device_activity_ok(p_activity jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare entry jsonb;
begin
  if p_activity is null or jsonb_typeof(p_activity) <> 'object' or length(p_activity::text) > 65536
    or (p_activity - array['sessions','nightShifts']) <> '{}'::jsonb
    or not (p_activity ?& array['sessions','nightShifts'])
    or jsonb_typeof(p_activity->'sessions') <> 'array' or jsonb_array_length(p_activity->'sessions') > 50
    or jsonb_typeof(p_activity->'nightShifts') <> 'array' or jsonb_array_length(p_activity->'nightShifts') > 20
  then return false; end if;
  for entry in select * from jsonb_array_elements(p_activity->'sessions') loop
    if jsonb_typeof(entry) <> 'object'
      or (entry - array['projectId','key','title','agent','state','startedAt','branch']) <> '{}'::jsonb
      or not (entry ?& array['projectId','key','title','agent','state','startedAt','branch'])
      or jsonb_typeof(entry->'projectId') <> 'string' or entry->>'projectId' !~ '^[A-Za-z0-9_-]{1,64}$'
      or jsonb_typeof(entry->'key') <> 'string' or entry->>'key' !~ '^[^\s/\\:]{1,24}-[0-9]{1,9}$'
      or jsonb_typeof(entry->'title') <> 'string' or length(entry->>'title') > 200
      or jsonb_typeof(entry->'agent') <> 'string' or entry->>'agent' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      or jsonb_typeof(entry->'state') <> 'string' or entry->>'state' not in ('working', 'waiting', 'blocked')
      or jsonb_typeof(entry->'startedAt') <> 'number'
      -- A branch name, never a folder: git itself allows no backslash, colon or leading slash in one.
      or not (entry->'branch' = 'null'::jsonb or (jsonb_typeof(entry->'branch') = 'string' and entry->>'branch' ~ '^[^/\\:~\s][^\\:~\s]{0,199}$'))
    then return false; end if;
  end loop;
  for entry in select * from jsonb_array_elements(p_activity->'nightShifts') loop
    if jsonb_typeof(entry) <> 'object'
      or (entry - array['projectId','done','total','startedAt']) <> '{}'::jsonb
      or not (entry ?& array['projectId','done','total','startedAt'])
      or jsonb_typeof(entry->'projectId') <> 'string' or entry->>'projectId' !~ '^[A-Za-z0-9_-]{1,64}$'
      or jsonb_typeof(entry->'done') <> 'number' or jsonb_typeof(entry->'total') <> 'number'
      or jsonb_typeof(entry->'startedAt') <> 'number'
    then return false; end if;
  end loop;
  return true;
end;
$$;

-- False when the account has no such machine (removed, or never given a place): nothing is kept.
create function public.tomrade_report_device_activity(p_device text, p_activity jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.tomrade_device_activity_ok(p_activity) then raise exception 'Invalid device activity' using errcode = '22023'; end if;
  update public.tomrade_devices set activity = p_activity, activity_at = now(), last_seen_at = now()
    where user_id = actor and device_id = p_device and removed_at is null;
  return found;
end;
$$;

-- What a removed machine was doing goes with what it said about itself.
create or replace function public.tomrade_remove_device(p_device text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update public.tomrade_devices set removed_at = now(), facts = '{}'::jsonb, activity = '{}'::jsonb, activity_at = null, updated_at = now()
    where user_id = actor and device_id = p_device and removed_at is null;
  if not found then raise exception 'No such device' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.tomrade_device_activity_ok(jsonb), public.tomrade_report_device_activity(text, jsonb) from public, anon, authenticated;
grant execute on function public.tomrade_report_device_activity(text, jsonb) to authenticated;

commit;
