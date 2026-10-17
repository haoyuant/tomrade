-- Announcements from Tomrade to every install: written only with the service
-- role (apps/store-admin `announce`), read by any app, signed in or not. A
-- row is shown once per machine; the app keeps which ones it has shown.
begin;

create table public.tomrade_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  -- Markdown; links open in the browser.
  body text not null default '' check (length(body) <= 20000),
  level text not null default 'info' check (level in ('info', 'important')),
  -- Null reaches every language; 'en' or 'zh' only an app in that language.
  locale text check (locale in ('en', 'zh')),
  -- A semver range the app's version must satisfy, e.g. '<0.5.0'; null is every version.
  versions text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);
create index tomrade_announcements_starts on public.tomrade_announcements (starts_at);

alter table public.tomrade_announcements enable row level security;
revoke all on public.tomrade_announcements from anon, authenticated;
grant select on public.tomrade_announcements to anon, authenticated;

create policy tomrade_announcements_current on public.tomrade_announcements
  for select to anon, authenticated
  using (withdrawn_at is null and starts_at <= now() and (ends_at is null or ends_at > now()));

commit;
