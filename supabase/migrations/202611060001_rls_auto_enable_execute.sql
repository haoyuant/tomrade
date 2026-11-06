-- Prod has public.rls_auto_enable(), the security definer behind the dashboard's
-- "enable RLS on new tables" event trigger. No migration made it, so nothing took
-- back the EXECUTE that PostgreSQL gives PUBLIC, and /rest/v1/rpc exposed it.
-- The event trigger still fires without that grant. Local databases and the tests
-- have no such function; there this does nothing.
begin;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

commit;
