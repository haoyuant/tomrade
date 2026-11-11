-- A machine may say whether it takes work from the account's other machines, and within what: for which
-- projects, how much a sent session may do without asking, and how many at once. It is what the others
-- read before they ask; the limits themselves are checked on the machine that takes the work.
begin;

create or replace function public.tomrade_device_facts_ok(p_facts jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare agent jsonb; repo jsonb; accept jsonb; project jsonb;
begin
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or length(p_facts::text) > 65536
    or (p_facts - array['platform','arch','version','git','agents','repos','accept']) <> '{}'::jsonb
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
  -- Optional: whether the machine takes work from the account's others, and within what.
  if p_facts ? 'accept' then
    accept := p_facts->'accept';
    if jsonb_typeof(accept) <> 'object' or (accept - array['on','projects','ceiling','concurrent']) <> '{}'::jsonb
      or not (accept ?& array['on','projects','ceiling','concurrent'])
      or jsonb_typeof(accept->'on') <> 'boolean'
      or jsonb_typeof(accept->'ceiling') <> 'string' or accept->>'ceiling' not in ('read', 'ask', 'edits', 'full')
      or jsonb_typeof(accept->'concurrent') <> 'number' or (accept->>'concurrent') !~ '^[1-8]$'
      or not (accept->'projects' = '"all"'::jsonb or (jsonb_typeof(accept->'projects') = 'array' and jsonb_array_length(accept->'projects') <= 200))
    then return false; end if;
    if jsonb_typeof(accept->'projects') = 'array' then
      for project in select * from jsonb_array_elements(accept->'projects') loop
        if jsonb_typeof(project) <> 'string' or (project #>> '{}') !~ '^[A-Za-z0-9_-]{1,64}$' then return false; end if;
      end loop;
    end if;
  end if;
  return true;
end;
$$;

commit;
