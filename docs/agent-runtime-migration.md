# Agent runtime migration and A/B evaluation

The default transports are now Claude Agent SDK and Codex app-server. The
legacy headless CLIs remain available with `transport: "cli"` as an explicit
rollback and comparison arm.

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
allow-list, then run (the example uses one repetition; three or more is better):

```sh
TOMRADE_EVAL_ENGINE=codex \
TOMRADE_EVAL_MODEL=<fixed-codex-model> \
TOMRADE_EVAL_REPETITIONS=3 \
pnpm eval:agents

TOMRADE_EVAL_ENGINE=claude-code \
TOMRADE_EVAL_MODEL=<fixed-claude-model> \
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

