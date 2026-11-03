-- Whether a person wants email from Tomrade beyond their account's own mail (confirmation,
-- password reset): news and updates. The sign-up form asks, ticked by default, and passes
-- the answer as `marketing_emails` in the new user's metadata; the row is written here when
-- the auth row is, since an account awaiting email confirmation has no session to write it.
-- Metadata stays editable by its user, so this table, not the metadata, is the record.
-- Mail goes only to rows with marketing = true.
create table public.tomrade_email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  marketing boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.tomrade_email_preferences enable row level security;
revoke all on public.tomrade_email_preferences from anon, authenticated;
grant select, update (marketing) on public.tomrade_email_preferences to authenticated;
create policy own_preferences_read on public.tomrade_email_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_preferences_write on public.tomrade_email_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create function public.tomrade_email_preferences_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger tomrade_email_preferences_touch before update on public.tomrade_email_preferences
  for each row execute function public.tomrade_email_preferences_touch();

create function public.tomrade_record_email_preferences() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tomrade_email_preferences(user_id, marketing)
    values (new.id, coalesce(new.raw_user_meta_data->'marketing_emails' = 'true'::jsonb, false))
    on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.tomrade_record_email_preferences() from public, anon, authenticated;
revoke all on function public.tomrade_email_preferences_touch() from public, anon, authenticated;
create trigger tomrade_record_email_preferences after insert on auth.users
  for each row execute function public.tomrade_record_email_preferences();

-- Accounts made before this migration: whatever their sign-up carried (an app that already
-- asks may ship before the push), else no mail.
insert into public.tomrade_email_preferences(user_id, marketing)
  select id, coalesce(raw_user_meta_data->'marketing_emails' = 'true'::jsonb, false) from auth.users
  on conflict (user_id) do nothing;
