-- A person deletes their own account from the app, after it has checked their password.
-- Everything keyed to the user goes with the auth row: their Hub (records, receipts,
-- membership), publisher profile and reports cascade. Plugins they published stay
-- listed for the people who use them; their owner and submitter become null.
-- Storage refuses to delete a user who still owns objects, so the package files they
-- uploaded are handed to no one first. They stay in place, still served to installers.
create or replace function public.tomrade_delete_account()
returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if to_regclass('storage.objects') is not null then
    update storage.objects set owner = null, owner_id = null where owner = actor or owner_id = actor::text;
  end if;
  delete from auth.users where id = actor;
end;
$$;

revoke all on function public.tomrade_delete_account() from public, anon, authenticated;
grant execute on function public.tomrade_delete_account() to authenticated;
