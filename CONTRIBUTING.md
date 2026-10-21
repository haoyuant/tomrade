# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything bigger than a fix, open an issue first so we can agree on the shape before you write it.

By contributing you agree that your work is licensed under the [Apache License 2.0](LICENSE), like the rest of the repository, and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

You need Node.js (CI uses 26) and pnpm 11; `corepack enable` picks the version pinned in `package.json`.

```sh
git clone https://github.com/haoyuant/tomrade.git
cd tomrade
pnpm install      # once per checkout or worktree, and again after the lockfile changes
pnpm dev          # builds the backend, then Vite + Electron
```

A checkout run with `pnpm dev` keeps its own data and serves MCP on port 19091, so it runs beside an installed Tomrade.

**On macOS, run the tests on Homebrew's node, not nvm's.** A notarized node can make every child process wait 30 seconds or more, and the suite then fails with mass timeouts that have nothing to do with your change. `pnpm test` picks a fast node for you (`TOMRADE_TEST_NODE` if set, else the first adhoc-signed or unsigned node it finds) and prints which one it used. [`docs/testing.md`](docs/testing.md) has the details.

## Check your change

```sh
pnpm typecheck      # tsc -b for the backend, then the UI
pnpm lint           # ESLint: React hooks rules for the UI, a few TypeScript rules everywhere
pnpm test:related   # only the tests that reach what you changed against origin/main
pnpm test           # vitest across every package
```

Iterate with `pnpm test:related`, and run the full `pnpm test` once before you open the pull request. It ends with a **Failures by kind** block (`real`, `network`, `timeout-under-load`); [`docs/testing.md`](docs/testing.md) says what each means. A `real` failure blocks a merge.

`pnpm lint:unused` lists unused files, exports and dependencies (knip); it reports without failing, so read it when you remove or move code.

`pnpm test:ui` drives the real Electron app. It is slow and has a known flaky baseline, so run it when you change the UI's behaviour, not on every change.

Every pull request runs `pnpm typecheck` and `pnpm test` in CI, forks included.

## House rules

- **Plugins first.** If a feature can be a plugin, make it one; the core reads contracts only. Official plugins that are not part of the app live in [tomrade-plugins](https://github.com/haoyuant/tomrade-plugins), and [`docs/plugin-api.md`](docs/plugin-api.md) is the contract. [`packages/README.md`](packages/README.md) says what each package here does.
- **Every user-facing string is translated, in English and Chinese.**
  - In the UI, a string goes through `t(...)`. Each feature file in `packages/ui/src/lib/i18n-messages/` exports `en` and `zh`, and `index.ts` types the Chinese as `zh: typeof en`, so a missing Chinese string fails `pnpm typecheck`.
  - The other built-in languages (`i18n-messages/locales/`: de, es, fr, ja, ru, zhHant) are partial: any string they lack shows in English. Adding to them is welcome, not required.
  - In the backend, a package's words live in its `src/words.ts`, written with `defineWords(id, { en, zh })`; the Chinese must have every key and the same `{{slots}}`. Prompts written for an agent are not words and stay in English.
- **Short why-comments only.** The code says what; a comment says why.
- **Domain words** (ticket, delivery, code link, sync back, …) mean what [`CONTEXT.md`](CONTEXT.md) says.

## Commits and pull requests

- Keep a pull request to one change, and say in its description what changed, why, and how you checked it. Paste the node and the **Failures by kind** block from your last full `pnpm test`.
- Write commit messages as a short sentence about the change. You may see `TOM-42: …` in the history: those are keys from the maintainer's own backlog. You don't need one.
- Pull requests are squash-merged, so the title becomes the commit on `main`.
- A user-facing change should show what it looks like: a screenshot or a short recording, in both languages if it adds strings.

## The agent config in this repository

Tomrade is built with Tomrade. `.mcp.json`, `.codex/`, `.cursor/`, `.gemini/`, `CLAUDE.md` and `AGENTS.md` point coding agents at the maintainer's backlog. Without that project on your machine the `tomrade` server is simply not there, and your agent carries on as usual. Please leave those files out of your pull request unless the change is about them.
