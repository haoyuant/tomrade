# Usage analytics in the cloud

User-facing explanation: [Data use and privacy](data-privacy.md) /
[数据使用与隐私说明](data-privacy.zh-CN.md).

Tomrade's anonymous usage data lives in the account Supabase project but in
tables and functions of its own: nothing here joins the Hub catalog, and no
column can name a person, a project, a file or a path.

Apply `supabase/migrations/202610230001_analytics.sql`. It creates:

| Object | Role |
| --- | --- |
| `tomrade_analytics_registry` | The feature ids, actions and counted flags the server validates against |
| `tomrade_analytics_event` | One row per accepted event, partitioned by month on `ts` |
| `tomrade_analytics_actor_daily` | `(day, region, feature_id, anon_id)`; the only place a period's distinct people are counted |
| `tomrade_analytics_feature_daily` | Sessions, active milliseconds and actors per feature, day, region and client minor |
| `tomrade_analytics_action_daily` | Events and counted events per action and dim |
| `tomrade_analytics_rate` | Batch counts per anonymous id for the hourly cap |
| `tomrade_analytics_new_installs` | Anonymous ids met for the first time, per hour, for the cap on new installs |
| `tomrade_ingest_analytics(jsonb)` | The only write path; granted to `anon` |
| `tomrade_analytics_retention()` | Drops whole event months past 180 days, actors past 180 days, aggregates past 25 months |

## Ingest

`POST {project}/rest/v1/rpc/tomrade_ingest_analytics` with the publishable key
and an `X-Tomrade-Analytics: 1` header:

```json
{ "p_batch": { "batch_id": "…", "sent_at": 1792747832000, "events": [ … ] } }
```

The function refuses (`400`) a batch or event with a field outside
`Tomrade 功能清单与埋点规范`'s envelope, refuses an action its registry does
not know, drops an unregistered `dim` from an otherwise valid event, keeps an
event for an unknown feature with `unknown_feature = true`, and answers
`202` with `{"accepted": n, "duplicates": n, "rejected": n}`. A retried batch
is safe: `(event_id, ts)` is the primary key. More than 500 events is `413`;
more than 60 batches an hour for one anonymous id is `429`. So is a new
anonymous id once the hour has met 500 of them, all installs together, which
keeps a caller minting an id per batch from going around the first cap; ids
already seen are untouched, and the client sends a refused batch again later.
A deployment moves the cap with
`alter database postgres set tomrade.analytics_new_installs_per_hour = 2000;`.

The region is inferred at ingest from the edge's country header
(`cf-ipcountry`, `x-vercel-ip-country` or `x-tomrade-country`) and reduced to
`cn`, `apac`, `eu`, `na` or `other` inside the function. The analytics tables do
not store the country or plaintext IP. Configure the edge and hosting logs to
exclude them too; the SQL migration does not control provider logging.

## Retention

Schedule the job wherever the project runs its other maintenance (for example
Supabase's `pg_cron`):

```sql
select cron.schedule('tomrade-analytics-retention', '17 3 * * *',
                      $$select public.tomrade_analytics_retention()$$);
```

The function is idempotent and reports what it removed. It only drops a month
once that whole month is older than 180 days, so a partition still holding a
row inside the retention window is never taken. An event can therefore remain
beyond 180 days until its entire month expires.
Daily actor rows are kept for 180 days; feature/action aggregates keep 25 months
and contain no `anon_id`.

## One contract, two deployments

With regional hosting, routing and scope guards configured, mainland and
international detail are stored separately: the mainland project
holds `region = 'cn'` only, the international one holds every other bucket.
Both run the same migrations, so a row has the same shape and the same
meaning wherever it landed, and the dashboard can add the two aggregate sets
together without a translation step.

Each deployment names its side once:

```sql
-- the mainland project
alter database postgres set tomrade.analytics_scope = 'cn';
-- the international project
alter database postgres set tomrade.analytics_scope = 'global';
```

The scope guard refuses a row that belongs on the other side with
`421 Unprocessable Content` (PostgREST's `PT421`); the client treats that as a
configuration error, drops the batch and never retries it across a border.
With the setting unset, both sides are accepted, which is right for a test or a
single-deployment install.

Point each build at its endpoint. An ordinary build leaves the choice on
`auto` and posts to the project's routing edge; a regional build sets:

| Variable | Value |
| --- | --- |
| `TOMRADE_ANALYTICS_ENDPOINT` | `cn` or `global` |
| `TOMRADE_ANALYTICS_URL_CN` | the mainland project's URL |
| `TOMRADE_ANALYTICS_URL_GLOBAL` | the international project's URL |
| `TOMRADE_ANALYTICS_KEY` | that project's publishable key |

The key is the public publishable key: RLS and the ingest function's own
validation are the boundary, so the key may ship in the build. Never ship a
service-role key.

## When the endpoint is down

The client keeps the batch in its local queue and retries with backoff. If the
endpoint is unreachable for longer than the queue's seven days, the oldest
events expire; the person sees nothing and no part of Tomrade waits on an
upload.

## The dashboard across both

The aggregator runs in each region on its own detail and writes the three
aggregate tables there. The dashboard reads both projects with service-role
keys and adds the rows by `day` × `region` × `feature_id`; no detail row is
copied across, and no `anon_id` is returned in the report summaries. The
actor-daily table behind distinct counts does contain IDs and stays in its own
region. Distinct-actor
metrics are added region by region; someone who used Tomrade on both sides in
one period is counted once per region, the price of never joining identifiers
across the border.

## Aggregation and the report

`tomrade_analytics_aggregate(from, to)` rewrites `tomrade_analytics_actor_daily`,
`tomrade_analytics_feature_daily` and `tomrade_analytics_action_daily` for the
days named. It deletes those days first, so re-running a range is both the retry and the way a late
event is folded in exactly once. The metric definitions live in this function
and in the dashboard's labels; no screen derives its own.

```sql
-- Hourly: the last three days, including one that is not over.
select cron.schedule('tomrade-analytics-hourly', '7 * * * *',
                      $$select public.tomrade_analytics_aggregate(current_date - 2, current_date)$$);
-- Nightly: the last 35 days, after the last timezone has closed its day.
select cron.schedule('tomrade-analytics-nightly', '23 2 * * *',
                      $$select public.tomrade_analytics_aggregate(current_date - 34, current_date)$$);
```

A failed run is safe to repeat; if the scheduler gives up, run the same
`select` by hand for the range it missed. The job reports what it wrote.

`tomrade_analytics_report(from, to, region)` answers one JSON document for the
dashboard: `totals` (`duration_ms`, `sessions`, `uses`, `aai`), `daily`,
`features`, `actions` and `retention` (D+1, D+7 and D+30 for each cohort first
seen in the range), plus `latest` — the newest `received_at` in the range, so
the page can say the data is behind. A day with no data is absent from
`daily`, never a zero. The three tables are keyed by day first, so a 7-, 30- or
90-day report is one indexed range scan per table.

The dashboard adds the two deployments' reports: totals and daily rows are
sums, and distinct-actor counts are added region by region.

## Site, accounts and platforms

Three more reports sit beside the usage report (`202611040003_site_daily.sql`,
`202611040004_accounts_platforms.sql`), each granted to `service_role` only.

- `tomrade_site_daily` holds the site's daily numbers per region: installer
  downloads and updater downloads from download.tomrade.com (by platform and
  version) and page views and visits of tomrade.com. tomrade-site's daily
  **Analytics** workflow copies them from Cloudflare's edge analytics through
  `tomrade_site_sync(from, to, rows)`, which replaces those days, so a re-run or
  a backfill lands once. The job sends a country per row; the function reduces
  it to the five regions (`tomrade_analytics_bucket`, which ingest now uses too)
  and stores no country. Rows of the other deployment's side are dropped, as
  ingest refuses them. Each sync also drops rows past 25 months. Cloudflare
  keeps 31 days, so a gap the job missed for longer is lost; how downloads are
  counted is in tomrade-site's README (Analytics).
  `tomrade_site_report(from, to, region)` answers totals, daily rows, platforms,
  versions and `synced_at`, the newest copy.
- `tomrade_accounts_report(from, to)` counts the registered accounts in
  `auth.users` by the end of the range (and how many confirmed their address)
  and the new ones inside it, per UTC day. Accounts carry no region, so the
  dashboard's region filter does not apply; anonymous sign-ins and deleted
  accounts are not counted.
- `tomrade_analytics_platforms(from, to, region)` counts active anonymous IDs
  and active time per operating system, read from the event detail (kept 180
  days, longer than any dashboard range).

The dashboard adds both deployments' answers, as for the usage report. Its
activation funnel starts at the site's installer downloads once the sync has
run, so installs over downloads is the conversion.

