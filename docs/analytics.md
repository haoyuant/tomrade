# Usage analytics in the cloud

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
more than 60 batches an hour for one anonymous id is `429`.

The region is inferred at ingest from the edge's country header
(`cf-ipcountry`, `x-vercel-ip-country` or `x-tomrade-country`) and reduced to
`cn`, `apac`, `eu`, `na` or `other` inside the function. The country and the
IP are not written anywhere and do not appear in logs.

## Retention

Schedule the job wherever the project runs its other maintenance (for example
Supabase's `pg_cron`):

```sql
select cron.schedule('tomrade-analytics-retention', '17 3 * * *',
                      $$select public.tomrade_analytics_retention()$$);
```

The function is idempotent and reports what it removed. It only drops a month
once that whole month is older than 180 days, so a partition still holding a
row inside the retention window is never taken. Detail older than 180 days is
gone; the aggregated tables keep 25 months and contain no `anon_id`.
