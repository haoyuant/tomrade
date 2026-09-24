# Plugin review worker

Every plugin submitted to Community is built and reviewed here before it is listed.

## What one review does

1. Fetches exactly the submitted commit from the publisher's public GitHub repository.
2. Installs production dependencies from the committed lockfile with every install script off.
3. Builds with `tomrade-plugin build`, inspects it in the sandbox (Node's permission model: no disk writes, no child processes), and stamps what it injects and registers.
4. Loads it into a throwaway project in the sandbox and runs its scenario.
5. Reads the bundle with the static analyzer, and the source (plus, for an update, the diff from the last listed version) with Claude.
6. Applies the listing rules (`src/pipeline.ts` → `decide`):
   - **rejected** — clearly malicious code, or it does not build, load or match its submission;
   - **held** for a person — suspected harm, critical static findings the model did not explain, prompt injection, a model refusal, or a submission too large to read whole;
   - **listed** — everything else. High risk (starting programs, disk anywhere, any host) is labelled, not refused.
7. A listed version is signed (`ATTESTATION.json`, Ed25519) and uploaded to the `plugin-packages` bucket. The badge is **AI 已审核**, or **官方审核** when the last listed version was reviewed by a person and the model judged the change small and low-risk with nothing new it can reach (`carryOver`).

## Setting it up

1. Apply `supabase/migrations/202609240001_plugins.sql` and `202609240002_plugin_review_worker.sql`.
2. Supabase Auth → Providers → GitHub: enable it, and add `http://127.0.0.1:**` to the redirect allow-list (the app links GitHub through a one-off server on this machine).
3. `node apps/review/dist/cli.js keygen --out <safe place>`; put the public key and its keyId in `apps/desktop/src/trust.ts` (`OFFICIAL_KEYS`) and ship a build.
4. Run the worker (`deploy/Dockerfile`, or `deploy/github-actions.yml`) with `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REVIEW_SIGNING_KEY`; optionally `REVIEW_MODEL` (default `claude-opus-5`) and `REVIEW_EFFORT` (default `high`).

## A person at Tomrade

```sh
tomrade-review queue                                # held versions, review requests, reports
tomrade-review show alice/notes@1.2.0               # the report
tomrade-review approve alice/notes@1.2.0 --notes "read the sync code; fine"   # lists it as 官方审核
tomrade-review reject alice/notes@1.2.0 --notes "sends issue titles to an undisclosed host"
tomrade-review revoke alice/notes --versions ">=1.2.0" --reason "exfiltrates data"   # machines switch it off
```
