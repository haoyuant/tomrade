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
`202611040003_site_daily`, `202611040004_accounts_platforms` and
`202611060003_search_github_daily`) to each analytics database and schedule `tomrade_analytics_aggregate` from the
deployment's scheduler. The report RPCs are granted
only to `service_role`; public and signed-in clients cannot read them. A
deployment without the newest migrations still loads: its site, accounts,
platform, SEO and GitHub sections are left empty. Site downloads and page views,
Search Console's numbers and the repository's GitHub traffic arrive once
tomrade-site's daily Analytics workflow runs with their secrets (its README,
Analytics); SEO and GitHub have no region and show the same in every region.

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

The page defaults to 30 UTC days, with 7/30/90/180/365-day and region filters,
English and Chinese labels, headline cards, a daily overview, usage/minutes
ranking, a per-feature daily trend, D+1 retention and the full feature table; it
follows the system's light or dark theme. It uses the whole width of the window:
on wide screens cards sit two to a row.

The header's **Exclude internal / Include internal** switch (URL
`internal=include`; excluded by default) leaves out the maintainer's own
installs: every anonymous ID that ever sent an event from a non-release build
(a `-`/`+` version such as `0.26.0-dev`, or `0.1.0` from an unpackaged
checkout). A release build run with `TOMRADE_ANALYTICS_INTERNAL=1` reports
`X.Y.Z+internal` and counts as internal too. The AI analysis reads the same view
and is told which one it read.

Each card except the headline has a window of its own: pick one in the card's
header and only that card changes (the URL keeps it as `w_<card>=<days>`, so a
view can be bookmarked). Picking the page's window again makes the card follow
the page. Each window is queried once, for only the cards that use it.

**AI analysis and suggestions** sends this view's aggregates (no IDs or raw
events) and those of the previous period of equal length to the local Claude
Code CLI (`claude -p`, with no tools, MCP servers or settings, and the
`SUPABASE_*` variables removed from its environment) and shows key points,
anomalies and suggestions. It runs only when you press Generate / Refresh
analysis (about a minute; it uses your Claude Code sign-in and costs what the
model charges, shown on the card). The result is kept per period and region in
`~/.tomrade-store/analytics-insights.json` (`TOMRADE_ANALYTICS_STATE_DIR` moves
it), so it is there after a restart; a view without one shows the newest
analysis, labelled with its own period. `TOMRADE_ANALYTICS_CLAUDE` names the
`claude` binary and `TOMRADE_ANALYTICS_MODEL` a model (for example `sonnet` for
a cheaper run). Charts are drawn by ECharts, which the server
hands out from this package under `/assets/` (the page loads nothing from the
network); the tables carry the same numbers without scripts. Use **Refresh** to
reload. Both regions
must answer successfully: an unavailable configured source shows an error,
not an apparently complete partial total. Queries time out after 15 seconds.
Only numeric report aggregates cross deployments; identifiers never do.
Cross-deployment active counts are sums, not globally deduplicated people.
Missing days are gaps; current-day and not-yet-observed retention are labeled.
