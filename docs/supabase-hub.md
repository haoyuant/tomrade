# Supabase Hub migration — phase one

Supabase Auth and Postgres own the account's portable Hub catalog and user
preferences in the production desktop build. Machine placement and project
storage continue to use their existing implementations.

## Cloud records

Apply `supabase/migrations/202609100001_hub.sql`. The migration creates only
namespaced tables and functions; it does not modify project tables or Auth's
managed schema.

| Table | Contents |
| --- | --- |
| `tomrade_hubs` | One personal Hub per `auth.users.id` |
| `tomrade_hub_members` | Membership and roles; phase one provisions only the owner |
| `tomrade_hub_records` | One versioned project reference, repository identity, or complete user-settings document per row |
| `tomrade_hub_receipts` | Idempotency receipts for successfully committed mutations |

`tomrade_hub_records` has `(hub_id, kind, key)` as its primary key. Projects and
repositories remain independent conflict boundaries. All portable preferences are
stored in the single `preference/settings` JSONB record. SQL NULL is a retained
deletion tombstone. Each successful write increments
the row's `version`. This intentionally small typed metadata store is not a
generic place to upload project tables or plugin state.

Authenticated members can read their Hub's rows through RLS. Direct client
writes and membership changes are denied. `tomrade_ensure_hub()` creates the
caller's personal Hub; `tomrade_mutate_hub()` checks owner membership, the base
version, and the mutation id inside one transaction. A repeated request returns
its original result; the same id with a different payload is refused. Member
invitations and switching between multiple Hubs are outside phase one.

## Local files and migration

| Location | Role after enabling cloud |
| --- | --- |
| `<userData>/accounts.json` | Machine-wide: which folder each account on this machine uses, and which opens next |
| `<userData>/account.enc` | Supabase session encrypted with the OS-backed Electron cipher |
| `<userData>/hub-cloud.json` | Account/endpoint binding, downloaded records, durable outbox, observed local facts and unresolved conflicts |
| `<userData>/catalog.json`, `device.json` | Machine placement and identity |
| `<userData>/settings.json` | Existing machine settings and local preference fallback; unchanged |
| `<userData>/cache/**` | Existing SQLite caches; unchanged |
| `<project>/.tomrade/**` | Existing project fact source, log and snapshots; unchanged |

The first cloud boot derives portable project and repository records from the
machine catalog into a durable queue. No network write happens until an account
signs in. User settings subsequently travel as one schema-validated settings
document; machine settings and password-bearing sections stay local.

The cloud cache belongs to one Supabase endpoint and one account, so each account
on a machine gets its own local Hub. The first account keeps the original folders
(`<userData>` and `~/Tomrade`); every other one gets `<userData>/accounts/<folder>`
and `~/Tomrade/accounts/<folder>`, the folder named after its email address.
`<userData>/accounts.json` maps account ids to folders and names the one the next
start opens. Plugin switches (`tomrade.patch.yml`) and installed extensions stay
per machine.

Signing in or creating an account always starts on a client that keeps no session.
The owner's session is then adopted here, and so is that of the first account on an
unowned local Hub. Any other account's session is written, encrypted, into its own
folder's `account.enc`. `accounts.json` is then pointed at that folder and the app
restarts into it. Nothing is merged or deleted: signing back in as the first account
restarts into the original folders with its projects where they were. Under
`pnpm dev`, Electron exits with `TOMRADE_RESTART_EXIT_CODE` and the launcher starts
it again, so the dev server survives the switch. A `userData` directory outside this
layout (a test or `boot()` caller) still refuses every account but its owner. Use a
separate `TOMRADE_USER_DATA` directory for a development instance.

The outbox is **not disposable**: unlike `cache/`, it contains edits that may not
have reached Supabase. Back it up with machine data. Writes use temporary files
and rename; queued requests retain their mutation ids across application restarts.

## Offline operation and conflicts

The UI initially requires account sign-in for configured cloud builds. After a
successful authenticated Hub connection, cached local projects remain usable
offline, including when the network prevents session renewal. Cloud operations
still require a valid Supabase session. An explicit local sign-out locks the UI
and keeps pending edits for the same account's next login; signing in as another
account from there opens that account's own local Hub instead. This is an application
gate, not encryption of project files or a change to the local MCP trust model.

Settings enqueue changes immediately. Project references are derived from the
existing machine catalog on startup, explicit sync and the periodic sync cycle;
project removals enqueue a tombstone synchronously before debounce/exit. The
default background interval is 30 seconds. File observations are remembered, so
an unchanged local checkout does not overwrite another device's metadata edit.

Each request carries a base version. A stale write retains both versions and
pauses that record; independent records continue to synchronize. The Hub account
panel lets the user choose the local or cloud value. Choosing local creates a
fresh mutation against the observed cloud version, which may conflict again if
another device writes meanwhile. No device clock decides concurrent edits.

After every successful sync, projects the account names and this machine lacks
are restored by themselves (`ctx.storage.restoreMissing()`): those with a
portable remote are cloned through their storage provider, one at a time; a
copy already under the Hub's `projects/` is adopted instead. Each shows on the
home screen as a card saying where it stands — restoring, offline, waiting for
its provider's account on this machine, or never backed up. A cloud catalog
entry alone does not back up a project folder, grant access to its Git
repository, or copy a checkout to the current machine: a project with no
remote can only be located by hand.

The first run's Default Project is created before the account is known. Until
someone uses it (an issue, history, a rename, any plugin row) it is never
written to the account, and it is removed once a restore brings in one of the
account's own projects, so every new machine does not add one more.

Legacy Hub Git binding is inactive in cloud mode; it is preserved in machine
configuration for rollback. If that Git repository also carries project files,
those files still require their existing Git transport/manual push. Supabase
does not replace that transport. Project-level Git providers are unchanged.

## Configure a deployment

1. Use the intended Supabase project (Tokyo for this deployment). Enable
   email/password sign-in and, if wanted, **Confirm email** in Supabase Auth.
   Confirmation needs custom SMTP (Authentication → Emails) and a raised email
   rate limit: the built-in mailer sends 2 emails an hour, and only to
   organization members. Production switched it off on 2026-10-11 and back on
   later the same day. Whether it is on can be read from the public
   `GET /auth/v1/settings` (`mailer_autoconfirm: false` means on). Set up the
   account email links as described in [Account emails](#account-emails).
2. Review and apply the SQL migration through the SQL Editor, or authenticate the
   CLI with `supabase login`, link the intended project using
   `supabase link --project-ref <project-ref>`, inspect
   `supabase db push --dry-run`, then run `supabase db push`.
3. Production builds already contain the Tokyo Project URL and publishable key.
   For development or another Supabase project, override them with:

   ```sh
   export TOMRADE_SUPABASE_URL='https://<project-ref>.supabase.co'
   export TOMRADE_SUPABASE_PUBLISHABLE_KEY='sb_publishable_...'
   export TOMRADE_USER_DATA='/absolute/path/to/isolated-tomrade-data'
   pnpm dev
   ```

   `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` are also accepted as aliases.
   These are read by `apps/desktop/src/hub-cloud.ts` in the main process. For a
   packaged app, the `hub-cloud` row in `tomrade.patch.yml` can instead receive
   `config: { userData: "${userData}", url: "...", publishableKey: "..." }`.
   No `.env` loader is implied. Keep the test data directory separate from the
   production app.
4. Register/sign in through Tomrade. If email confirmation is enabled, confirm
   the email and return to Tomrade, which signs in by itself; otherwise
   registering signs in. Check the account panel for pending changes, sync
   errors and conflicts.

## Account emails

Two emails link out of the app. Both land on pages of the promo site
(`tomrade-site`, `src/components/AuthPage.astro`), under `/zh/` when the app
shows Chinese:

| Email | Sent by | Link lands on | What the page does |
| --- | --- | --- | --- |
| Confirm signup | `account.signUp`, `account.resendConfirmation` | `https://tomrade.com/auth/confirmed/` | Says the email is confirmed (or the link is spent) and ends the link's own session |
| Reset password | `account.resetPassword` | `https://tomrade.com/auth/reset/` | Sets the new password through `PUT /auth/v1/user` with the link's session, then ends it |

The site is the hub-cloud row's `site` option (default `https://tomrade.com`).
In Supabase → Authentication → URL Configuration:

- **Site URL**: `https://tomrade.com/auth/confirmed/`. Builds before these pages
  pass no redirect, so their confirmation links land on the Site URL.
- **Redirect URLs**: add `https://tomrade.com/**`. Keep the loopback entry that
  Community's GitHub linking uses (`http://127.0.0.1:<port>/callback`).

A redirect missing from the list falls back to the Site URL. The probe
`GET /auth/v1/verify?type=signup&token=x&redirect_to=<url>` (an invalid token,
so it changes nothing) answers with a `Location` that shows which one won.

The two emails are bilingual (Chinese first, as in the app's brand line) and
live in `supabase/templates/`. Supabase does not read them from the repository:
paste each one under Authentication → Emails → Templates and set its subject.

| Template | File | Subject |
| --- | --- | --- |
| Confirm signup | `supabase/templates/confirm-signup.html` | `确认你的 Tomrade 邮箱 / Confirm your Tomrade email` |
| Reset password | `supabase/templates/reset-password.html` | `重设你的 Tomrade 密码 / Reset your Tomrade password` |

They use only `{{ .Email }}` and `{{ .ConfirmationURL }}`; nothing in the app
reads a code. The other templates (magic link, invite, email change,
reauthentication) are not used. After sign-up, the app waits on a **Check your email**
step that keeps the typed password in memory. It retries the sign-in when the
window regains focus, and on **I've confirmed, sign in**. **Resend email**
counts down from Supabase's one-email-a-minute limit, and when Supabase refuses
it uses the seconds Supabase reports. A sign-in refused with `email_not_confirmed`
opens the same step. With confirmation on, Supabase answers sign-up for an
address that already has an account with an identity-less user and sends
nothing. The app reports this as `user_already_exists`.

The desktop rejects secret/service-role keys and remote HTTP URLs. Sessions are
never sent to the renderer or stored as plaintext JSON. If the OS keychain is
unavailable (including Linux `basic_text`), secure persistence fails explicitly.

## Verification

`pnpm test` includes the real migration executed in PGlite's PostgreSQL runtime:
RLS visibility, grants, ownership, version conflicts, tombstones and idempotent
receipts. Service tests use a simulated Supabase client for failed networks,
lost replies, safe preference export and unchanged project write-through. The
encrypted-session adapter has its own persistence tests.

These checks do not replace live Auth/email testing or application of the
migration to the deployment. No live project is touched by the test suite.

## Auth log retention

Supabase Auth writes a row to `auth.audit_log_entries` for every sign-in,
sign-out, token refresh and password change, including the IP address. Its own
cleanup removes revoked refresh tokens and expired sessions, but nothing ever
removes audit rows. `supabase/migrations/202610120002_auth_audit_retention.sql`
enables `pg_cron` and schedules the job `tomrade-auth-audit-retention` daily at
03:17 UTC. The job deletes audit rows older than 90 days, the period the
privacy policy states.

- **Apply:** run `supabase db push` with the other migrations (see
  [Configure a deployment](#configure-a-deployment)). Applying it twice still
  leaves one job.
- **Verify:** in the SQL Editor, run
  `select jobname, schedule, username, command from cron.job;`. After 03:17 UTC,
  check
  `select status, return_message from cron.job_run_details order by start_time desc limit 1;`.
  It should show `succeeded` and `DELETE <n>`.
- **Why it works:** after Supabase's April 2025 restrictions, `postgres` still
  holds DELETE on auth tables; only `auth.schema_migrations` was revoked. A job
  runs as the role that scheduled it.
- **The alternative:** Authentication → Configuration → Audit Logs → turn off
  writing audit logs to the database. Then the only copy is the dashboard's log
  storage, which keeps auth audit logs for 1 hour on Free, 7 days on Pro and
  28 days on Team. That is too short to look into abuse on Free.
