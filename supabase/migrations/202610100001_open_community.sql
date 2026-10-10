-- Community without review: a publisher's own build of a public, open-source
-- commit is listed as soon as it is uploaded, and whoever installs it judges it.
-- Tomrade still revokes what reports show to be malicious, and signs its own
-- plugins as official.
begin;

drop function if exists public.tomrade_submit_plugin(jsonb, text, text, text);
drop function if exists public.tomrade_request_official_review(text, text);
drop function if exists public.tomrade_claim_submission(text);
drop function if exists public.tomrade_requeue_stale_submissions();
drop table if exists public.tomrade_plugin_submissions, public.tomrade_plugin_reviews, public.tomrade_plugin_review_requests;

alter table public.tomrade_plugin_versions
  drop constraint tomrade_plugin_versions_status_check,
  drop constraint tomrade_plugin_versions_tier_check,
  drop column reviewed_as,
  drop column report;

-- Submissions no worker ever reviewed will not be listed now; their plugins go with them.
delete from public.tomrade_plugin_versions where status not in ('listed', 'revoked');
delete from public.tomrade_plugins p where not exists (select 1 from public.tomrade_plugin_versions v where v.plugin_id = p.id);
update public.tomrade_plugin_versions set tier = 'community' where tier is distinct from 'official';

alter table public.tomrade_plugin_versions
  add constraint tomrade_plugin_versions_status_check check (status in ('listed', 'revoked')),
  alter column status set default 'listed',
  add constraint tomrade_plugin_versions_tier_check check (tier in ('community', 'official')),
  alter column tier set default 'community',
  alter column tier set not null;

-- Mirrors OSI_LICENSES in @tomradex/plugin-sdk; the client checks first, this is what holds.
create function public.tomrade_is_open_source(p_license text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_or(trim(replace(replace(l, '(', ''), ')', '')) = any (array[
    '0BSD', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'Artistic-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CDDL-1.0', 'EPL-1.0', 'EPL-2.0',
    'EUPL-1.2', 'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'ISC', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
    'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MIT', 'MIT-0', 'MPL-2.0', 'MS-PL', 'MulanPSL-2.0', 'NCSA', 'OSL-3.0', 'PostgreSQL', 'Unlicense', 'UPL-1.0', 'Zlib'
  ])), false)
  from regexp_split_to_table(coalesce(p_license, ''), '\s+OR\s+', 'i') as l;
$$;

-- A version is the publisher's build of one commit of a public repository they
-- own, uploaded first to <id>/<version>/<digest>.tomrade-plugin. Clients check
-- the package against the digest recorded here before they install it.
create function public.tomrade_publish_plugin(
  p_manifest jsonb, p_repository text, p_commit text, p_tag text, p_digest text,
  p_package_path text, p_package_size integer, p_risk text, p_risk_reasons text[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); pub public.tomrade_publishers%rowtype; existing public.tomrade_plugins%rowtype;
  v_id text := p_manifest->>'id'; v_version text := p_manifest->>'version'; v_license text := coalesce(p_manifest->>'license', '');
  v_ns text := coalesce(p_manifest->>'namespace', replace(split_part(p_manifest->>'id', '/', 2), '-', '_'));
  v_owner text := lower(split_part(regexp_replace(p_repository, '^https://github\.com/', ''), '/', 1));
  recent integer;
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
  if not public.tomrade_is_open_source(v_license) then
    raise exception 'The store takes open-source plugins only; "%" is not an OSI-approved SPDX identifier', v_license using errcode = '22023';
  end if;
  if p_digest !~ '^[0-9a-f]{64}$' then raise exception 'The package digest is not a SHA-256' using errcode = '22023'; end if;
  if p_package_path is distinct from v_id || '/' || v_version || '/' || p_digest || '.tomrade-plugin' then
    raise exception 'Upload the package to %/%/%.tomrade-plugin', v_id, v_version, p_digest using errcode = '22023';
  end if;
  if p_package_size is null or p_package_size <= 0 or p_package_size > 20971520 then raise exception 'A package is at most 20 MB' using errcode = '22023'; end if;
  if p_risk is null or p_risk not in ('low', 'elevated', 'high') then raise exception 'Risk is low, elevated or high' using errcode = '22023'; end if;
  -- Supabase Storage exists only in the real project; local tests have no storage schema.
  if to_regclass('storage.objects') is not null then
    if not exists (select 1 from storage.objects o where o.bucket_id = 'plugin-packages' and o.name = p_package_path) then
      raise exception 'Upload the package before publishing it' using errcode = '22023';
    end if;
  end if;
  select count(*) into recent from public.tomrade_plugin_versions where submitted_by = actor and submitted_at > now() - interval '1 day';
  if recent >= 20 then raise exception 'Too many versions today; try again tomorrow' using errcode = '54000'; end if;

  select * into existing from public.tomrade_plugins where id = v_id;
  if found then
    if existing.owner_id is distinct from actor then raise exception 'Another account owns %', v_id using errcode = '42501'; end if;
    if existing.namespace <> v_ns then raise exception 'A plugin keeps its namespace (%)', existing.namespace using errcode = '22023'; end if;
  else
    if exists (select 1 from public.tomrade_plugins where namespace = v_ns) then raise exception 'The namespace % is taken; set another in tomrade-plugin.json', v_ns using errcode = '23505'; end if;
    insert into public.tomrade_plugins(id, publisher, owner_id, namespace, title, description, repository, license, fork_of)
      values (v_id, pub.github_login, actor, v_ns, coalesce(p_manifest->>'title', v_id), coalesce(p_manifest->>'description', ''), p_repository, v_license, p_manifest->'forkOf'->>'id');
  end if;
  if exists (select 1 from public.tomrade_plugin_versions v where v.plugin_id = v_id and v.version = v_version) then
    raise exception 'Version % was already published; bump the version', v_version using errcode = '23505';
  end if;

  insert into public.tomrade_plugin_versions(plugin_id, version, commit_sha, tag, status, tier, risk, risk_reasons, sdk_range, manifest, digest, package_path, package_size, submitted_by, listed_at)
    values (v_id, v_version, p_commit, p_tag, 'listed', 'community', p_risk, coalesce(p_risk_reasons, '{}'), p_manifest->'engines'->>'sdk', p_manifest, p_digest, p_package_path, p_package_size, actor, now());
  update public.tomrade_plugins
    set latest_version = v_version, title = coalesce(p_manifest->>'title', title), description = coalesce(p_manifest->>'description', description),
        repository = p_repository, license = v_license, updated_at = now()
    where id = v_id;
end;
$$;

revoke all on function public.tomrade_is_open_source(text), public.tomrade_publish_plugin(jsonb, text, text, text, text, text, integer, text, text[]) from public, anon, authenticated;
grant execute on function public.tomrade_is_open_source(text) to anon, authenticated;
grant execute on function public.tomrade_publish_plugin(jsonb, text, text, text, text, text, integer, text, text[]) to authenticated;

-- A publisher uploads only under its own GitHub login, and never over a package already there.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute $policy$
      create policy tomrade_publisher_uploads on storage.objects for insert to authenticated with check (
        bucket_id = 'plugin-packages'
        and name like '%.tomrade-plugin'
        and (storage.foldername(name))[1] = (select p.github_login from public.tomrade_publishers p where p.user_id = (select auth.uid()))
      )
    $policy$;
  end if;
end $$;

commit;
