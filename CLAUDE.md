# Tomrade

Local-first backlog workbench: an Electron app (`apps/desktop`) with a React UI (`packages/ui`) over a plugin-based backend (`packages/*`, TypeScript, pnpm workspace). Domain language lives in `CONTEXT.md`.

## Layout

- `apps/desktop` — Electron main process, preload, packaging, Electron-driven UI checks (`scripts/*-check.mjs`)
- `packages/ui` — renderer: React 19, TanStack Router/Query, Tailwind; strings in `src/lib/i18n-messages/` (en + zh, hand-rolled i18n)
- `packages/*` — core and plugins (`@tomradex/*` / `@tomrade/*`): items, storage, agent engines, files, settings, MCP, …

## Commands

- `pnpm install` — needed once per fresh worktree
- `pnpm typecheck` — `tsc -b` for the backend, then the UI
- `pnpm test` — vitest across packages
- `pnpm test:ui` — Electron UI regression harness (slow; has a known flaky baseline)
- `pnpm dev` — run the desktop app

## Conventions

- Build features as plugins where possible; core reads contracts only.
- Every user-facing string goes through `t(...)` with both en and zh entries.
- Minimal comments: short why-comments only.
- Commit messages name the ticket key (e.g. `TOM-42: …`).
