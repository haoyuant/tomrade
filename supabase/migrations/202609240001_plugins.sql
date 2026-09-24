-- Community plugins: publishers, listings, versions, the review pipeline's queue,
-- reports and revocations. Everything is readable by anyone; accounts write only
-- through the functions at the bottom, and the review worker (service role) does
-- the rest. Packages live in the public `plugin-packages` bucket; the client
-- trusts them because it checks each one's digest against a signed attestation,
-- not because of where they were downloaded from.
begin;

-- A publisher is an account with a linked GitHub identity: the login is the
-- publisher part of every plugin id it owns, and GitHub is where the source is.
create table public.tomrade_publishers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_login text not null unique check (github_login ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  github_id text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.tomrade_plugins (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9-]{0,63}$'),
  publisher text not null,
  owner_id uuid references auth.users(id) on delete set null,
  namespace text not null unique check (namespace ~ '^[a-z][a-z0-9_]{1,31}$'),
  title text not null,
  description text not null default '',
  repository text not null check (repository ~ '^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'),
  license text not null,
  fork_of text,
  latest_version text,
  downloads bigint not null default 0,
  delisted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per submitted version. `tier` is what the store vouches for:
-- ai-reviewed for every listed version, reviewed once a person at Tomrade has
-- read it (or the AI judged its change from a reviewed version small), official
-- for Tomrade's own. High risk is labelled here, not refused.
create table public.tomrade_plugin_versions (
  plugin_id text not null references public.tomrade_plugins(id) on delete cascade,
  version text not null check (version ~ '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$'),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  tag text,
  status text not null default 'queued' check (status in ('queued', 'building', 'reviewing', 'listed', 'held', 'rejected', 'revoked')),
  tier text check (tier in ('ai-reviewed', 'reviewed', 'official')),
  risk text check (risk in ('low', 'elevated', 'high')),
  risk_reasons text[] not null default '{}',
  sdk_range text,
  manifest jsonb,
  digest text check (digest ~ '^[0-9a-f]{64}$'),
  attestation jsonb,
  report jsonb,
  -- The version whose human review this one's badge carries, when it does.
  reviewed_as text,
  package_path text,
  package_size integer,
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  listed_at timestamptz,
  primary key (plugin_id, version)
);

create table public.tomrade_plugin_submissions (
  id uuid primary key default gen_random_uuid(),
  plugin_id text not null,
  version text not null,
  repository text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  tag text,
  submitted_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  worker text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index tomrade_plugin_submissions_queue on public.tomrade_plugin_submissions(created_at) where status = 'queued';

-- What a person at Tomrade decided, and why. Written by the admin tool.
create table public.tomrade_plugin_reviews (
  id uuid primary key default gen_random_uuid(),
  plugin_id text not null,
  version text not null,
  reviewer text not null,
  decision text not null check (decision in ('approved', 'rejected', 'changes')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table public.tomrade_plugin_review_requests (
  plugin_id text not null,
  version text not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  primary key (plugin_id, version)
);

create table public.tomrade_plugin_reports (
  id uuid primary key default gen_random_uuid(),
  plugin_id text not null,
  version text,
  reporter uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('malware', 'broken', 'misleading', 'license', 'other')),
  details text not null default '' check (length(details) <= 4000),
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now()
);

-- Clients check this list when online and switch a match off.
create table public.tomrade_plugin_revocations (
  plugin_id text not null,
  versions text not null default '*',
  reason text not null,
  revoked_at timestamptz not null default now(),
  primary key (plugin_id, versions)
);

alter table public.tomrade_publishers enable row level security;
alter table public.tomrade_plugins enable row level security;
alter table public.tomrade_plugin_versions enable row level security;
alter table public.tomrade_plugin_submissions enable row level security;
alter table public.tomrade_plugin_reviews enable row level security;
alter table public.tomrade_plugin_review_requests enable row level security;
alter table public.tomrade_plugin_reports enable row level security;
alter table public.tomrade_plugin_revocations enable row level security;

revoke all on public.tomrade_publishers, public.tomrade_plugins, public.tomrade_plugin_versions, public.tomrade_plugin_submissions,
  public.tomrade_plugin_reviews, public.tomrade_plugin_review_requests, public.tomrade_plugin_reports, public.tomrade_plugin_revocations from anon, authenticated;

grant select on public.tomrade_publishers, public.tomrade_plugins, public.tomrade_plugin_versions, public.tomrade_plugin_revocations, public.tomrade_plugin_reviews to anon, authenticated;
grant select on public.tomrade_plugin_submissions, public.tomrade_plugin_review_requests, public.tomrade_plugin_reports to authenticated;

create policy public_publishers on public.tomrade_publishers for select to anon, authenticated using (true);
create policy public_plugins on public.tomrade_plugins for select to anon, authenticated using (not delisted or owner_id = (select auth.uid()));
-- Anyone sees what is listed or was revoked; a publisher also sees its own in review.
create policy public_versions on public.tomrade_plugin_versions for select to anon, authenticated using (
  status in ('listed', 'revoked') or submitted_by = (select auth.uid())
);
create policy public_revocations on public.tomrade_plugin_revocations for select to anon, authenticated using (true);
create policy public_reviews on public.tomrade_plugin_reviews for select to anon, authenticated using (true);
create policy own_submissions on public.tomrade_plugin_submissions for select to authenticated using (submitted_by = (select auth.uid()));
create policy own_requests on public.tomrade_plugin_review_requests for select to authenticated using (requested_by = (select auth.uid()));
create policy own_reports on public.tomrade_plugin_reports for select to authenticated using (reporter = (select auth.uid()));

-- The GitHub identity Supabase Auth linked to this account is the proof: no
-- token of the user's reaches Tomrade.
create function public.tomrade_become_publisher() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); login text; gh_id text; name text; result public.tomrade_publishers%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select lower(i.identity_data->>'user_name'), coalesce(i.identity_data->>'provider_id', i.identity_data->>'sub', i.provider_id), i.identity_data->>'full_name'
    into login, gh_id, name
    from auth.identities i where i.user_id = actor and i.provider = 'github' order by i.created_at desc limit 1;
  if login is null then raise exception 'Link a GitHub account first' using errcode = '42501'; end if;
  insert into public.tomrade_publishers(user_id, github_login, github_id, display_name) values (actor, login, gh_id, name)
    on conflict (user_id) do update set github_login = excluded.github_login, github_id = excluded.github_id, display_name = excluded.display_name
    returning * into result;
  return to_jsonb(result);
end;
$$;

-- A submission names a public GitHub repository and one commit; the worker
-- builds from exactly that. The publisher part of the id is the caller's
-- GitHub login, and so is the repository's owner.
create function public.tomrade_submit_plugin(p_manifest jsonb, p_repository text, p_commit text, p_tag text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); pub public.tomrade_publishers%rowtype; existing public.tomrade_plugins%rowtype;
  v_id text := p_manifest->>'id'; v_version text := p_manifest->>'version';
  v_ns text := coalesce(p_manifest->>'namespace', replace(split_part(p_manifest->>'id', '/', 2), '-', '_'));
  v_owner text := lower(split_part(regexp_replace(p_repository, '^https://github\.com/', ''), '/', 1));
  recent integer; submission uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into pub from public.tomrade_publishers where user_id = actor;
  if not found then raise exception 'Become a publisher first' using errcode = '42501'; end if;
  if v_id is null or v_version is null or split_part(v_id, '/', 1) <> pub.github_login then
    raise exception 'A plugin id must start with your GitHub login (%)', pub.github_login using errcode = '42501';
  end if;
  if split_part(v_id, '/', 1) = 'tomrade' then raise exception 'The tomrade publisher is reserved' using errcode = '42501'; end if;
  if v_owner <> pub.github_login then raise exception 'The repository must belong to %', pub.github_login using errcode = '42501'; end if;
  if p_commit !~ '^[0-9a-f]{40}$' then raise exception 'Name one commit by its full hash' using errcode = '22023'; end if;
  select count(*) into recent from public.tomrade_plugin_submissions where submitted_by = actor and created_at > now() - interval '1 day';
  if recent >= 20 then raise exception 'Too many submissions today; try again tomorrow' using errcode = '54000'; end if;
  if exists (select 1 from public.tomrade_plugin_submissions where tomrade_plugin_submissions.plugin_id = v_id and status in ('queued', 'running')) then
    raise exception 'This plugin already has a submission in review' using errcode = '55000';
  end if;
  select * into existing from public.tomrade_plugins where id = v_id;
  if found then
    if existing.owner_id is distinct from actor then raise exception 'Another account owns %', v_id using errcode = '42501'; end if;
    if existing.namespace <> v_ns then raise exception 'A plugin keeps its namespace (%)', existing.namespace using errcode = '22023'; end if;
  else
    if exists (select 1 from public.tomrade_plugins where namespace = v_ns) then raise exception 'The namespace % is taken; set another in tomrade-plugin.json', v_ns using errcode = '23505'; end if;
    insert into public.tomrade_plugins(id, publisher, owner_id, namespace, title, description, repository, license, fork_of)
      values (v_id, pub.github_login, actor, v_ns, coalesce(p_manifest->>'title', v_id), coalesce(p_manifest->>'description', ''), p_repository,
              coalesce(p_manifest->>'license', ''), p_manifest->'forkOf'->>'id');
  end if;
  if exists (select 1 from public.tomrade_plugin_versions where tomrade_plugin_versions.plugin_id = v_id and tomrade_plugin_versions.version = v_version and status not in ('rejected')) then
    raise exception 'Version % was already submitted; bump the version', v_version using errcode = '23505';
  end if;
  delete from public.tomrade_plugin_versions where tomrade_plugin_versions.plugin_id = v_id and tomrade_plugin_versions.version = v_version and status = 'rejected';
  insert into public.tomrade_plugin_versions(plugin_id, version, commit_sha, tag, submitted_by, manifest, sdk_range)
    values (v_id, v_version, p_commit, p_tag, actor, p_manifest, p_manifest->'engines'->>'sdk');
  insert into public.tomrade_plugin_submissions(plugin_id, version, repository, commit_sha, tag, submitted_by)
    values (v_id, v_version, p_repository, p_commit, p_tag, actor) returning id into submission;
  return submission;
end;
$$;

create function public.tomrade_report_plugin(p_plugin text, p_version text, p_reason text, p_details text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); recent integer; result uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select count(*) into recent from public.tomrade_plugin_reports where reporter = actor and created_at > now() - interval '1 day';
  if recent >= 20 then raise exception 'Too many reports today' using errcode = '54000'; end if;
  if not exists (select 1 from public.tomrade_plugins where id = p_plugin) then raise exception 'No such plugin' using errcode = '22023'; end if;
  insert into public.tomrade_plugin_reports(plugin_id, version, reporter, reason, details) values (p_plugin, p_version, actor, p_reason, coalesce(p_details, ''))
    returning id into result;
  return result;
end;
$$;

create function public.tomrade_request_official_review(p_plugin text, p_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not exists (select 1 from public.tomrade_plugins where id = p_plugin and owner_id = actor) then
    raise exception 'Only the plugin''s publisher can ask for its review' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tomrade_plugin_versions where plugin_id = p_plugin and version = p_version and status = 'listed') then
    raise exception 'Only a listed version can be reviewed' using errcode = '22023';
  end if;
  insert into public.tomrade_plugin_review_requests(plugin_id, version, requested_by) values (p_plugin, p_version, actor) on conflict do nothing;
end;
$$;

-- Counted, not tracked: no account or address is stored with a download.
create function public.tomrade_count_download(p_plugin text) returns void
language sql security definer set search_path = '' as $$
  update public.tomrade_plugins set downloads = downloads + 1 where id = p_plugin;
$$;

revoke all on function public.tomrade_become_publisher(), public.tomrade_submit_plugin(jsonb, text, text, text), public.tomrade_report_plugin(text, text, text, text),
  public.tomrade_request_official_review(text, text), public.tomrade_count_download(text) from public, anon, authenticated;
grant execute on function public.tomrade_become_publisher(), public.tomrade_submit_plugin(jsonb, text, text, text), public.tomrade_report_plugin(text, text, text, text),
  public.tomrade_request_official_review(text, text) to authenticated;
grant execute on function public.tomrade_count_download(text) to anon, authenticated;

-- The bucket exists only where Supabase Storage does; local tests have no storage schema.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
      values ('plugin-packages', 'plugin-packages', true, 20971520, array['application/gzip', 'application/octet-stream'])
      on conflict (id) do nothing;
  end if;
end $$;

commit;
