# Data use and privacy

[简体中文](data-privacy.zh-CN.md)

Tomrade uses feature-usage statistics to understand which features are useful,
how often they are used, and how much active time they take. This page covers
that statistics feature. Account sign-in, project sync, AI providers and reports
you choose to send are separate features with their own data flows.

## What the statistics contain

- The feature used, such as Board or Notes, and a predefined action such as
  opening it or creating an item. They contain no details about that item.
- Active time for timed features, action counts and event times. Background
  time is excluded; timing pauses after 60 seconds without input.
- A random anonymous identifier, used to count active installations and return
  visits. These counts are not a count of identifiable people.
- App version, operating-system family (macOS, Windows or Linux), and versions
  of the event format and feature list. Events also carry random event/session
  identifiers and ordering information to handle retries.
- One broad region: mainland China, Asia Pacific, Europe, North America or
  Other. A predefined category, such as an engine or channel type, may accompany
  an action; user-entered text does not.

**Usage statistics do not collect specific project data:** no project names,
ticket titles or bodies, notes, chat messages, prompts, model responses, code,
file names, repository paths, search terms or settings values. They do not
include your email, account ID, hardware fingerprint or plaintext IP address.
The client and receiver allow only the defined event fields; unexpected
content fields cause the batch to be rejected.

A network service necessarily receives a source address to deliver a request.
The analytics database stores only the broad region, not that address or the
country used to derive it. Hosting and routing logs must also be configured to
exclude those addresses; a database schema alone cannot control provider logs.

## How the anonymous identifier works

Tomrade generates a random secret on your computer. The secret stays there;
a derived identifier is sent with usage events. It is not derived from your
account, email or hardware and is not joined to account or project records.
It cannot be used to sign in or decoded to recover an account identity.

The identifier changes every 365 days (approximately 12 months). You can also
choose **Reset identifier** in **Settings → Data & privacy**. Resetting creates
a new secret and identifier and discards unsent events. Events under the same
identifier can be grouped during its lifetime; this is how activity and return
visits are counted. The system provides no identity mapping between an old
identifier and a replacement. This describes the safeguards, not a promise
that any possible combination with outside information is risk-free.

## Purpose and retention

The statistics are for product analysis: feature use, active time, broad regions
and trends. They are not for advertising, personal profiles or model training,
and are not sold to third parties.

| Data | Retention |
| --- | --- |
| Unsent events on your computer | Up to 7 days, subject to a 20,000-event / 20 MB limit; oldest events are discarded first |
| Cloud event details | A 180-day window, cleaned by whole calendar month after every event in that month is older than 180 days; some events therefore remain until that month's cleanup |
| Daily activity rows containing anonymous IDs | 180 days |
| Feature/action totals without anonymous IDs | 25 months |

These cloud limits require the scheduled cleanup job to run. Deployment policy
also calls for backups to expire within 35 days and address-free edge status
counts within 30 days; those limits must be configured in the hosting services.
The database jobs are defined in `supabase/migrations`. A source checkout does not establish that a live service has
been deployed or that its hosting settings have been verified.

## Turn statistics off

Open **Settings → Data & privacy → Anonymous usage statistics** and switch it
off. Collection and timing stop, pending requests and retries are cancelled,
the local unsent queue is cleared and the local identity secret is deleted.
No new usage requests are sent while it is off. This does not disable project
work, sync, licensing or updates. Turning it on again creates a new identifier.

Turning statistics off or resetting the identifier does not recall events
already accepted by the server. Those events expire under the retention rules.
If you want to request removal sooner, copy the identifier shown in settings
**before** resetting it or switching statistics off, and contact the maintainer
through a private support channel. Do not post it in a public issue. Requests
can refer to that identifier, not to an email or account that analytics does not
hold. The specification calls for handling such requests within 30 days; there
is currently no self-service deletion button. Totals that no longer contain
identifiers cannot be attributed back to a particular request.

The current implementation defaults to enabled. Before a mainland-China
release, the operator must resolve the consent/default setting identified in
the specification and provide notice before the first upload. This document
does not certify a deployment's compliance or replace that release decision.

## Where the data goes

The design uses separate mainland-China and international endpoints. When
configured for the two regions, mainland detail stays in the mainland database
and international detail stays in the international database. The receiver
rejects a mismatched region, and the client does not retry the same batch
across the border. A shared internal dashboard reads numeric summaries from
both sides; it does not transfer event rows or anonymous identifiers between
them. Counts across deployments are added without matching identifiers.

Regional routing, the database scope guard, cleanup schedules and provider-log
settings must be in place before this separation can be claimed for a release.
If you deploy Tomrade yourself, apply `supabase/migrations`, schedule their
cleanup and aggregation jobs, and check your endpoints; selecting “auto” alone does not create regional hosting.
