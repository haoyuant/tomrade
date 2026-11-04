# Community admin

Nothing listed in Community is reviewed. A publisher's build of a public, open-source commit is listed as soon as it is published, and whoever installs it reads what it can reach on their own machine first. Tomrade keeps two powers, both here:

- **revoke** a plugin that reports show to be malicious: machines switch it off at their next check;
- **sign** one of Tomrade's own plugins as **official**, with the store key whose public half is in `apps/desktop/src/trust.ts`.

```sh
tomrade-store reports                                   # open reports
tomrade-store show alice/notes@1.2.0                    # a listed version as the store holds it
tomrade-store official tomrade-app/pet@1.0.0            # STORE_SIGNING_KEY or STORE_SIGNING_KEY_FILE
tomrade-store revoke alice/notes --versions ">=1.2.0" --reason "exfiltrates data"
tomrade-store keygen --out <safe place>                 # a new store key
```

It also reads the **troubleshooting reports** people send from the app (Troubleshoot → Send to the developer). A report holds only what its sender read and ticked; the same failure seen by many people shares a fingerprint.

```sh
tomrade-store diag                                      # new reports, grouped by fingerprint, most common first
tomrade-store diag --all                                # every status
tomrade-store diag R-7K3F2A                             # one report, section by section
tomrade-store diag import --project <id>                # new reports → TOM tickets in a running Tomrade (its MCP, 127.0.0.1:19090), one per fingerprint
tomrade-store diag reply --ticket TOM-60 "Fixed in 0.7.0 — update and it signs in." --status fixed --in 0.7.0
tomrade-store diag status R-7K3F2A wontfix              # new, triaged, fixed, wontfix or duplicate
```

The sender sees the status, the reply and the fixing release in Settings → About → My reports. The bottom bar says so until they read it.

**Announcements** pop up once in every Tomrade, signed in or not, within the hour or at its next launch. The body is Markdown; its links open in the browser.

```sh
tomrade-store announce                                  # what every install can see now, with ids
tomrade-store announce publish "Tomrade 0.8" --file notes.md --until 2026-11-01
tomrade-store announce publish "请升级" "0.5 之前的版本无法登录，请到 tomrade.com 下载新版。" --level important --locale zh --versions "<0.5.0"
tomrade-store announce withdraw <id>                    # machines that showed it already are not asked again
```

Known issues people can fix themselves belong in the site's `known-issues.json` (`{ "version": 1, "issues": [...] }`, the `KnownIssue` shape in `@tomradex/doctor`). Every Tomrade reads it within six hours, so no release is needed.

Every command but `keygen` needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Internal usage dashboard

Apply the analytics migrations (`202610230001` onward, including
`202611040001_site_daily` and `202611040002_accounts_platforms`) to each
analytics database and schedule aggregation as described in
[analytics operations](../../docs/analytics.md). The report RPCs are granted
only to `service_role`; public and signed-in clients cannot read them. A
deployment without the two newest migrations still loads: its site, accounts
and platform sections are left empty. Site downloads and page views arrive once
tomrade-site's daily Analytics workflow runs (its README, Analytics).

```sh
# Supply these through your shell, a secret manager or the repository's
# gitignored .env (read when present; the shell wins), never through the page:
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (international)
# SUPABASE_URL_CN, SUPABASE_SERVICE_ROLE_KEY_CN (optional mainland deployment)
pnpm analytics                # builds, then serves on 19100
pnpm analytics --port 19200   # another port
```

Open `http://127.0.0.1:19100`. The server binds only to loopback, checks the
Host/Origin, sends no CORS allowance, and does not expose keys or raw events.
Keep this operator tool on a trusted machine; do not publish it or proxy it to
a public address. For remote operation use an SSH local port forward with the
same local and remote port. Stop it with Ctrl+C.

The page defaults to 30 UTC days, with 7/30/90-day and region filters, English
and Chinese labels, headline cards, a daily overview, usage/minutes ranking, a
per-feature daily trend, D+1 retention and the full feature table; it follows
the system's light or dark theme. Charts are drawn by ECharts, which the server
hands out from this package under `/assets/` (the page loads nothing from the
network); the tables carry the same numbers without scripts. Use **Refresh** to
reload. Both regions
must answer successfully: an unavailable configured source shows an error,
not an apparently complete partial total. Queries time out after 15 seconds.
Only numeric report aggregates cross deployments; identifiers never do.
Cross-deployment active counts are sums, not globally deduplicated people.
Missing days are gaps; current-day and not-yet-observed retention are labeled.
