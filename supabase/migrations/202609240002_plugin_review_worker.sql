-- The review worker claims one queued submission at a time; two workers never take the same one.
begin;

create function public.tomrade_claim_submission(p_worker text) returns setof public.tomrade_plugin_submissions
language sql security definer set search_path = '' as $$
  update public.tomrade_plugin_submissions s set status = 'running', worker = p_worker, started_at = now()
  where s.id = (
    select id from public.tomrade_plugin_submissions where status = 'queued' order by created_at limit 1 for update skip locked
  )
  returning s.*;
$$;

-- A submission whose worker died is taken again after half an hour.
create function public.tomrade_requeue_stale_submissions() returns integer
language sql security definer set search_path = '' as $$
  with stale as (
    update public.tomrade_plugin_submissions set status = 'queued', worker = null, started_at = null
    where status = 'running' and started_at < now() - interval '30 minutes' returning 1
  ) select count(*)::integer from stale;
$$;

revoke all on function public.tomrade_claim_submission(text), public.tomrade_requeue_stale_submissions() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.tomrade_claim_submission(text), public.tomrade_requeue_stale_submissions() to service_role;
  end if;
end $$;

commit;
