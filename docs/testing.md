# Testing

`pnpm test` runs vitest over every package. After vitest's own output it prints one more block, **Failures by kind**: the count of each kind, then one line per failing test (or suite, file, or unhandled error) with the line of the error that decided it.

```
Failures by kind: real 1 · network 2 · timeout-under-load 0  (merge rule: docs/testing.md)
  real                packages/items/tests/items.test.ts > ranks a new card — expected 2 to be 1
  network             packages/x/tests/y.test.ts > reads the catalog — getaddrinfo ENOTFOUND tomrade.com
  network             packages/x/tests/z.test.ts > pushes — fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com
```

The reporter is `packages/testkit/src/failure-kinds.ts`, listed after `default` in `vitest.config.ts`.

## The three kinds

- **`timeout-under-load`**: vitest's own limit ran out, `Test timed out in …ms` or `Hook timed out in …ms`, and nothing else about the test failed.
- **`network`**: the error, or one of its causes, is the network not being there: DNS (`ENOTFOUND`, `EAI_AGAIN`, `getaddrinfo`, `Could not resolve host`, `no such host`), a refused, reset or timed-out connection (`ECONNREFUSED`, `ECONNRESET`, `connect ETIMEDOUT`, `Failed to connect to … port …`), an unreachable network, a proxy that refused or could not tunnel, and TLS or certificate failures. git, curl and `gh` output wrapped in an ordinary error counts.
- **`real`**: everything else. An assertion is always `real`, whatever its message mentions. So is a refusal from a socket file, or from a loopback port that no `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` names: that is a server the test started, not the network. So are a poll that never matched (`Matcher did not succeed in time.`), a child process that outlived its own limit (`spawnSync … ETIMEDOUT`), and a bare `fetch failed` with no cause.

When the reporter is unsure, it says `real`. A test with several errors is `real` if any of them is, then `network` (a network wait often ends in a timeout), then `timeout-under-load`.

## Before calling a failure "load"

Check which `node` runs the tests. On macOS a notarized node outside Homebrew (nvm's, for one) can make every child process wait while the system checks it online: 30–50 s per spawn on the maintainer's Mac, against about 50 ms for Homebrew's. The whole suite took 808 s with 80 failures under nvm's node and 55 s with 1 failure under Homebrew's (2026-10-18). Mass timeouts are this, not the code under test.

`pnpm test` (`scripts/test.mjs`) picks the node for you and prints it first: `TOMRADE_TEST_NODE` when set, else on macOS the first adhoc-signed or unsigned node among the current one, those on `PATH`, `/opt/homebrew/bin/node` and `/usr/local/bin/node`, else the current one. Its directory goes first on `PATH`, so fakes started as plain `node` use it too, and vitest's workers inherit it as `process.execPath`. It also times one `node -e 0` while the run starts and warns when that takes over 1 s; the warning never holds the run. A full run (no path or file named) also waits its turn: one full `pnpm test` at a time on this machine, through a lock in the system temp folder; the next one prints `waiting for the test run in <worktree> (pid N)` and starts when it ends, and a lock whose run is gone is taken over. Runs of a file or package skip the lock. vitest uses at most 4 workers; `TOMRADE_TEST_WORKERS` changes that. `pnpm test:ui` runs under Electron, whose spawns go through Electron's own binary, so it is not affected.

## When a pull request may merge with failing tests

A pull request may merge with failing tests only when **both** hold:

1. Every failure is `timeout-under-load` or `network`. Any `real` failure blocks the merge.
2. The same tests fail the same way on `origin/main`: run those test files there and compare the kinds.

The pull request's description carries the **Failures by kind** block from the run it was judged on, the `node` that ran it, and the result of the comparison with `origin/main`.

Reruns are capped: a `network` failure is rerun at most once, a `timeout-under-load` file at most twice. After that, record it and report it; never loop.

## Tests that need the network

A test never needs the network to pass. Either it answers itself (a local server on `127.0.0.1`, an injected `fetch`, a fake binary first on `PATH`), or it is opt-in and skipped unless its flag is set, like the `TOMRADE_LIVE_*` suites (`TOMRADE_LIVE_CC=1 pnpm test` runs the real Claude Code). A restricted network must show up as `skipped`, never as a timeout.

To check, restrict the network for one run, for example by pointing every proxy at a closed local port so git, curl and `gh` fail at once:

```sh
HTTPS_PROXY=http://127.0.0.1:19 HTTP_PROXY=http://127.0.0.1:19 ALL_PROXY=http://127.0.0.1:19 \
NO_PROXY=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=1 pnpm test
```

Without `NODE_USE_ENV_PROXY=1`, Node's own `fetch` ignores the proxy variables and still reaches the network.
