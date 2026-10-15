# Agent runtime migration and A/B evaluation

Every Claude Code turn runs through the Claude Agent SDK and every Codex turn
through Codex app-server. The per-turn headless CLIs (`claude -p`,
`codex exec`) are gone; a `transport` left in saved settings or a thread's
options is ignored.

## Runtime behavior

Tomrade keeps a small in-process runtime pool keyed by `projectId:threadId`.
An idle runtime is reused for up to five minutes (maximum three runtimes); a
different model, effort, command, environment, MCP URL, or tool description
invalidates the runtime. A runtime is never shared by two concurrent turns.
The pool is disposed with the Cordis context, and Codex/Claude cancellation
first uses the provider interrupt protocol before terminating the process.

The provider session ID is still persisted in the thread's external state, so
an evicted runtime can resume the same provider conversation. MCP requests use
the active run token on every request; an idle runtime cannot accidentally use
the previous run's write permissions.

## Paired evaluation

The paid-provider test is opt-in. Fix one model, effort, command, and tool
allow-list, name the engine options the baseline arm differs by, then run:

```sh
TOMRADE_EVAL_ENGINE=codex \
TOMRADE_EVAL_MODEL=<fixed-codex-model> \
TOMRADE_EVAL_BASELINE='{"effort":"high"}' \
TOMRADE_EVAL_REPETITIONS=3 \
pnpm eval:agents

TOMRADE_EVAL_ENGINE=claude-code \
TOMRADE_EVAL_MODEL=<fixed-claude-model> \
TOMRADE_EVAL_BASELINE='{"model":"<other-claude-model>"}' \
TOMRADE_EVAL_REPETITIONS=3 \
pnpm eval:agents
```

The test alternates baseline/candidate order and uses independent provider
threads and fixture state. It records correctness, success/stop, MCP and native
tool calls, first streamed token (TTFT), visible text latency, elapsed time,
input/output tokens, cache-read/cache-write tokens, cost, compactions, model,
and cold/warm runtime metadata in `artifacts/agent-eval/*.json`. The candidate
gate requires every candidate fixture to pass and every follow-up turn to be
warm; the report is not a claim of statistical equivalence from a small sample.

Interpret Claude cost as the per-streaming-turn result value. Codex may not
provide a cost field, in which case it remains `null`; do not substitute a
local price estimate. Cache counters are provider counters and are reported
separately from uncached input.


## Local coding agent parity

A `code` turn (Run here) uses the installed local coding agent with its native
coding tools. Tomrade adds ticket context and its run-bound MCP server; the
backlog tool allowlist must not restrict coding tools, subagents, skills, or
other locally configured MCP servers. Claude loads user, project, and local
settings and the Claude Code tool preset. The SDK runtime and the terminal
launch template merge Tomrade's MCP configuration with local MCP
configuration instead of using strict MCP isolation for coding.

Coding turns have no default Tomrade turn-count ceiling. An explicit
`codeMaxTurns` or `maxBudgetUsd` remains respected. Backlog turns retain their
restricted tool set and default turn limit.

### Interactive permissions

The Agent Panel has a per-thread Permissions / mode selector for coding
threads. Claude defaults to native `auto`; Codex defaults to full access
(`danger-full-access` + `never`). Claude also offers full access, accept edits,
manual approval, plan, and local rules. Codex also offers workspace, read-only,
and local rules. Auto uses Claude's own classifier; it is not bypass mode.
The underlying provider may restrict mode availability.

Selections persist with the thread and do not change another thread. A choice
made during a run applies to its next turn; the panel keeps displaying the
active mode and labels the queued choice separately. Runtime fingerprints
include the mode, so the next turn reopens the provider runtime with the new
policy while resuming the conversation. Switching engines clears the selection.
Claude's initialization event reports its actual mode, including a provider
fallback from Auto. Local rules inherit Claude settings or read Codex's effective
local/project approval and sandbox config, also on resume.

Requests keep the current run alive. Users can allow one operation or deny it;
additional Codex permissions are granted only for the current turn. No permanent
allow-rule is written. Concurrent requests are queued, cancellation resolves as
denial, and old responses cannot approve a later request. Pending approvals are
in-memory and disappear after restart; the conversation retains their text.

MCP elicitation and provider-specific non-permission interaction are not yet
bridged by the app-server adapter.
