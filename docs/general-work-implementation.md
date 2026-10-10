# General work implementation

User-approved scope: one Ticket model, independent `kind` (ticket/epic) and
`workType` (coding/general); shared Delivery lifecycle, artifacts and review;
general agent execution without Git prerequisites; playbooks chosen by task
content and capabilities; all durable files belong to the future Files plugin.
This document records implementation boundaries and verification evidence.

## Implementation

- Work type persistence, additive legacy migration (coding), item APIs, built-in
  view field, SQL filtering, grouping writes, snapshot export/import, merge field
  mapping, and undo restoration.
- Backlog planning supports mixed work types and independently reviewable outcomes.
- Intake collects goal, materials, constraints, outcomes, and acceptance signal;
  software-specific dossier fields remain optional.
- Optional playbook recommendations, required/optional capabilities and outputs
  parse from frontmatter and survive source resolution. Existing files work.
- Git evidence judging skips general tickets. Coding starter rejects them;
  the General entry point is provided by Agent independently of code-link.
- New-ticket dialog, detail pane, and standalone ticket page expose work type
  with English/Chinese labels. General tickets use their own start button and
  method selector, without querying code-link sessions.
- Fixed a pre-existing Agent migration error: initial schema repeated the
  metrics_json column added by migration 6, preventing migration 7 (archived).
- Shared DeliveryStore and core deliveries table now back Coding and General.
  Core migration preserves legacy IDs, sequences, timestamps and Git baselines;
  old exported delivery rows import without requiring code-link. Code-link's
  existing public API delegates to the shared store.
- General status transitions create/finish deliveries without Git or Agent.
  Retries and review rejection keep the same delivery, reopening creates the next
  sequence. Item undo snapshots restore delivery state. Core snapshot export,
  import and merge include deliveries.
- General execution now binds a thread to the current Delivery, uses a separate
  temporary working directory without repository prerequisites, checks engine
  support and declared playbook capabilities, and continues the same method by
  default. Reopening creates a fresh thread and directory. Old delivery threads
  cannot execute after a new delivery starts. Agent success leaves the ticket
  in Doing, pending explicit submission and acceptance.
- Built-in task.assist and document.write playbooks are loaded by Agent. The
  document method requires files.write; this capability is not yet provided.
  Plugins can advertise capabilities with agent.capability; permission grants
  remain separate. Each run records the selected method's source, body and hash.
- Native Claude and Codex adapters support General execution with native tools
  and interactive permissions, without the Git-specific prompt protocol.
- Ticket evidence records immutable file references (input or output), selected
  output submissions, and human reviews in items.evidence_json. Existing item
  version checks, oplog/undo and sync apply together. Concurrent independent
  evidence records merge by ID. No file bytes or document/media content live in
  this metadata field.
- Files plugins register a version resolver through items.files. Missing plugin
  or version fails without creating evidence. add_delivery_resource and
  submit_delivery are agent tools; human review is a separate IPC/UI action.
- Both ticket surfaces show output selection, completion reports, acceptance,
  requests for changes, and submission history. Stale reviews fail. Report-only
  human work needs no files. An agent cannot mark Done a General delivery that
  has a submission or that an agent ran; one nobody delegated may be closed by
  an agent on the person's word, with no evidence written. Human direct
  completion records acceptance. Coding with outputs no longer auto-completes
  on merge. General without code history no longer shows a Code section.

- Ticket `playbookId` defaults persist through schema, snapshots and undo.
  Creation templates cover human/document/design/media work; General launch
  exposes engine and method selection in a compact menu. View options and
  creation copy are localized and do not assume every ticket is a PR.
- New-ticket creation asks the Worker LLM for an advisory work-type and Playbook
  recommendation from the title/brief. The chosen method is preselected and
  persisted; a manual work-type or method choice suppresses later automatic
  replacement. Missing models or malformed answers use deterministic fallback
  matching, and recommendations never bypass capability checks.
- Human takeover serializes against restart, including conversation sends, and
  waits for the engine to stop. Cancellation remains authoritative when an
  engine returns normally. Manually-created unbound General threads cannot
  accidentally enter the Coding execution path.
- Coding prompts read completion policy. Automatic completion respects every
  linked repository's policy. Mixed artifacts require human acceptance and all
  code links merged. A ticket mention in a squash commit does not count as proof
  that every branch of a multi-link delivery merged.
- General and explicitly opened Coding methods record immutable provenance.
  Active delivery type/kind changes are refused; closed history survives a type
  change. Delete and undo-create remove Delivery rows; undo-delete restores
  them. Purge removes them permanently, and legacy repair skips absent tickets.
- Sync checks delivery uniqueness, ticket existence, General lifecycle
  consistency, submitted resource references and review uniqueness. Ambiguous
  concurrent histories stop sync for reconciliation, retaining source copies.
- `CONTEXT.md` and `docs/plugin-api.md` document the vocabulary, APIs, capability
  boundaries and future Files picker/preview contract.

## Requirement audit and evidence

| Requirement | Authoritative coverage |
| --- | --- |
| Coding/General persistence, mixed filtering, legacy defaults | `items/tests/items.test.ts`, `items/tests/deliveries.test.ts`, domain schemas and built-in field query mapping |
| Shared history, retry/reopen, delete/purge, snapshot and undo | `items/tests/deliveries.test.ts`, `code-link/tests/store.test.ts`, core DeliveryStore unique indexes |
| Versioned Files references, input/output separation, report-only work, stale review | `items/tests/evidence.test.ts`; no file-content storage in Ticket evidence |
| Merge independent additions; reject unsafe concurrent undo/deliveries | `storage/tests/merge.test.ts`, `storage/tests/storage.test.ts` |
| No-repository execution, required capabilities, stable method and directory | `agent/tests/general.test.ts` |
| Engine success versus acceptance, human takeover, old delivery isolation | `agent/tests/general.test.ts` |
| Source precedence, capability metadata, method provenance | `agent/tests/playbooks.test.ts`, run snapshot assertion in `agent/tests/general.test.ts` |
| Mixed code/artifact acceptance and cross-repository policy | `code-link/tests/code-link.test.ts`; existing Coding start/connect/scanner regressions retained |
| Generic intake and mixed planning | `agent-backlog/tests/backlog.test.ts`, backlog playbooks and plan prompt |
| Creation, revision, acceptance, history, reopen, both ticket surfaces, the Start dialog (where / agent / recommended method, coding and General) | `apps/desktop/scripts/general-work-check.mjs` running real Electron + IPC + plugins, with isolated local data and cloud disabled |
| LLM method recommendation, invalid-answer fallback, and inferred work type | `agent/tests/playbooks.test.ts`; `agent.recommendPlaybook` IPC and New Ticket dialog |

The Electron regression passed its 20 UI checks and screenshots were inspected.
The in-app Browser skill could not initialize (missing classic-level.mjs), so
the repository's native Electron regression approach was used instead.

## Intentional boundaries

- Files storage, picker/preview and media-generation providers were future
  plugin scope when this landed. Files has since shipped as `@tomradex/files`
  (see `docs/plugin-api.md`, Files); media generation has not. Core supplies resolver/capability contracts and
  versioned references, not an alternative attachment store. Missing capabilities
  are explicit startup errors, never fabricated generated files.
- Sync cannot safely auto-resolve contradictory human reviews or incompatible
  delivery histories; it reports a reconciliation error instead of losing data.
- Two opt-in real-service engine tests are skipped without their configuration.
  Native engine protocol tests run using isolated fixtures; no live generation
  or external publishing was performed for verification.

## Verification commands

Final unit/integration suite: 403 passed, 2 configured live-service skips across
59 test files. Typecheck and production build pass. Native Electron regression
passes all 20 checks on both standalone and docked ticket surfaces. Screenshots
were retained in the isolated harness temp directories for visual inspection.

- `pnpm typecheck`
- `pnpm test`
- `pnpm build` (passes with the existing large-bundle warning)
- `git diff --check`
- With `pnpm dev:ui` running:
  `pnpm --filter @tomrade/desktop exec electron scripts/general-work-check.mjs`
