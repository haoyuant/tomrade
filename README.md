<p align="center">
  <img src="docs/images/banner.png" alt="Tomrade: the backlog your coding agents can read and write. Local-first, Claude Code and Codex over MCP, undo any run." width="820">
</p>

<p align="center">
  <a href="https://tomrade.com">Website</a> ·
  <a href="https://tomrade.com/download">Download</a> ·
  <a href="#connect-your-agents">Connect your agents</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="https://github.com/haoyuant/tomrade-plugins">Plugins</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-a83c32"></a>
  <img alt="Platforms: macOS, Windows, Linux" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-5b4636">
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-d9a441">
</p>

# Tomrade

**Tom + comrade.** Tasks, notes and agents, in one folder you own.

Your agents work at **3 a.m.** They read your tickets, edit your notes, and now and then rewrite **everything you own**. Tomrade is the workspace built for them, with **an undo button built for you**.

It's a local-first desktop app for solo makers and tiny teams. Run a codebase, your week, a journal or a shelf of docs from the same place. Say one sentence and the assistant drafts the whole backlog; hand a ticket to Claude Code, Codex or whichever coding agent you already use; undo any agent run in one click.

<p align="center">
  <img src="docs/images/board.png" alt="Tomrade's board: a sidebar of views and workstreams, ticket cards in Backlog and To Do columns, and the assistant panel on the right." width="900">
</p>

> [!NOTE]
> **Preview.** Until 1.0, Tomrade is in development and testing: things change from week to week and you will hit rough edges. Your projects are plain folders on your own disk, so back up the ones that matter.

## What's in the box

**🗣️ From a sentence to a pull request.** Describe what you want in plain words. The assistant asks what it needs to know, drafts epics and features sized for one PR, checks them against what already exists, and points out what's missing. The whole tree lands in one run. Press **Start** on a ticket and your own Claude Code, Codex, Gemini CLI or OpenCode picks it up on its own branch.

**⏪ No approval queue. Just undo.** *Approval queues? In this economy?* Agents write straight to the backlog, so nothing waits on you. Every run is grouped and attributed, and when one gets creative (renames "Fix login" to "Rewrite auth from scratch", marks all 14 tickets Urgent), one click puts all of it back. It never happened.

**🤝 Comrade, not foreman.** Other tools want the work done inside them. Tomrade goes both ways: hand a ticket out with Start, or keep working in the Claude Code or Codex you've already tuned, in your own terminal, and run `/tomrade:sync` (`$tomrade-sync` in Codex) to bring the session back. Git keeps score: name `TOM-42` in a branch and the ticket follows it to Doing, Verifying and Done. Work without a ticket is fine, and nothing nags you to file one.

**🖥️ The terminal, next to the board.** *Alt-Tab cardio: cancelled.* A Terminal window built on [herdr](https://herdr.dev) runs your agents in split panes, each pane tied to its ticket, each bar saying Running, Needs you or Idle. Quit Tomrade and your agents keep working.

**📓 A notebook beside your backlog.** Every project carries a folder of files: Markdown with a live preview, `[[wiki links]]` and backlinks, `#tags`, full-text search, a dated journal page for today. Every save is versioned and can sync to a GitHub repo. Attach files to tickets as deliverables.

**💬 Ask it anything in Tomrade.** The assistant isn't only a planner. It moves tickets, turns five journal entries into a weekly review, switches you to dark mode, draws an architecture diagram with the built-in [Archify](https://github.com/tt-a1i/archify), or helps you pick a name for your corgi. Every change lands in History, where ⌘Z takes it back.

**📱 Away from your desk? Message it.** *Toilet-break productivity unlocked.* Connect a bot in Discord, Slack, Telegram, Feishu / Lark, DingTalk or WeCom and the assistant answers from your phone: same project, same tools. Tomrade talks to each chat app directly, with no server of ours in between.

**📥 The backlog has a bouncer.** GitHub issues (and any source a plugin adds) wait in the project's inbox. The assistant proposes what each one is (a new ticket, a bug you already have, a duplicate) and drafts the reply. You click Confirm.

**🧩 Everything is a plugin, including yours.** The database, the tool registry, the MCP server and the assistant are each a plugin you can swap out. Write your own against the Apache-2.0 SDK and ship it under any license, or describe it in Plugin Studio and let an agent write and test it; it loads only after you confirm the build. Official plugins live in [tomrade-plugins](https://github.com/haoyuant/tomrade-plugins).

**🐱 Your agents have a supervisor now. It's a cat.** The desktop pet mirrors what your agent is doing: napping, thinking, LOCKED IN, staring at you until you answer its question, smug for exactly three seconds when a run succeeds, crying for three seconds when one fails so you don't have to. Not a cat person? Bring your own pet.

**🍅 Lock in. Don't forget your Kegels.** A tomato in the status bar: 25 minutes of focus, 5 off. The alert can be any audio file. What you do with those 5 minutes is between you and your pelvic floor.

<table>
  <tr>
    <td width="36%"><img src="docs/images/detail.png" alt="A ticket's detail pane: a Start button, a Lock button, status, priority, the tickets it blocks, and who changed it last."></td>
    <td><img src="docs/images/plugins.png" alt="The Settings dialog listing Tomrade's modules and the plugin that provides each one."></td>
  </tr>
  <tr>
    <td><sub>Every ticket says who changed it last, a person or an agent. Start hands it to your coding agent.</sub></td>
    <td><sub>Every module is a plugin. Switch them on and off in Settings › Manage plugins.</sub></td>
  </tr>
</table>

## Principles

Built so agents can move fast without stepping on you.

- **Your folder is the truth.** Each project is a folder of plain text you can read, diff and back up. SQLite is only a cache. *Delete the cache. It comes back. We'll wait.*
- **Human work comes first.** Every AI write records who made it and the version it read. Fields you lock stay locked, and a write based on a stale read is refused, whoever sends it. The one write undo can't reach, a permanent delete, is human-only.
- **One set of tools, every surface.** The in-app assistant and the agents in your editor call the same tools. Register one once and it shows up in both.
- **Bring your own model.** DeepSeek, Anthropic, OpenAI, Gemini, Kimi, OpenRouter, any OpenAI-compatible endpoint or a local model, with more providers as [plugins](https://github.com/haoyuant/tomrade-plugins). Or let your own Claude Code or Codex conduct, on your own login.
- **It asks before it acts.** A shell command waits for your Allow or Deny. API keys, MCP servers and command lines are never an agent's to change.
- **Local first, account optional.** Choose "Use without an account" and everything stays on this machine. An account only syncs your preferences and project list, never project content. Project content leaves your machine only if you connect a model provider or a git remote.

## Install

Get the installer for your system from **[tomrade.com/download](https://tomrade.com/download)** or the [GitHub releases](https://github.com/haoyuant/tomrade/releases).

| System | Installer | Notes |
|---|---|---|
| macOS 12+ (Apple silicon or Intel) | `.dmg` | Signed and notarized. Drag it to Applications and go. |
| Windows 10 / 11, 64-bit | `.exe` | Not code-signed yet, so SmartScreen will clutch its pearls: **More info → Run anyway**. Smart App Control blocks unsigned apps outright; read the [download page](https://tomrade.com/download) first. |
| Linux, x86-64 | `.AppImage` | `chmod +x` and run. Recent Ubuntu needs `libfuse2` (`libfuse2t64` on 24.04). |

An installed copy checks for updates and installs one only when you say so. The interface speaks English, 简体中文, 繁體中文, 日本語, Español, Deutsch, Français and Русский.

Then: create a project, tell the assistant in one sentence what you're up to, and, if you like, connect your agents.

## Connect your agents

Tomrade runs an MCP server at `http://127.0.0.1:19090/mcp`. It listens on 127.0.0.1 only; nothing is exposed to the network.

**The easy way:** in a project, open the repository a workstream stands for and connect coding agents, either **on this machine only** or **for the team** as a pull request. Tomrade writes the config for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, WorkBuddy and Pi, plus the notes that tell them how to claim a ticket and sync back. The details are in [`docs/agent-connections.md`](docs/agent-connections.md).

**By hand**, for any agent that speaks Streamable HTTP MCP:

```sh
# Claude Code
claude mcp add --transport http tomrade http://127.0.0.1:19090/mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.tomrade]
url = "http://127.0.0.1:19090/mcp"
```

```json
{
  "mcpServers": {
    "tomrade": { "type": "http", "url": "http://127.0.0.1:19090/mcp" }
  }
}
```

Your agent gets the same tools the assistant has: `list_items`, `get_item`, `create_item`, `update_item`, `change_status`, `claim_ticket`, `link_code`, `find_similar`, `plan_and_apply`, `search_files`, … plus whatever plugins add. Its writes follow the same rules as everyone's: attributed, versioned, refused on a locked field, undoable. The `whoami` tool tells it which Tomrade it reached.

## Build from source

You need Node.js (CI uses 26) and pnpm 11 (`corepack enable` picks the pinned version).

```sh
git clone https://github.com/haoyuant/tomrade.git
cd tomrade
pnpm install
pnpm dev          # builds the backend, then Vite + Electron
```

A checkout run with `pnpm dev` keeps its own data and serves MCP on port **19091**, so it runs side by side with an installed Tomrade (`TOMRADE_MCP_PORT` picks another port).

```sh
pnpm typecheck     # tsc -b for the backend, then the UI
pnpm test          # vitest across every package
pnpm test:related  # only the tests that reach what you changed against origin/main
pnpm test:ui       # the Electron UI harness (slow)
pnpm --filter @tomrade/desktop package   # installers: DMG/ZIP, NSIS, AppImage
```

On macOS, run the tests on Homebrew's node rather than nvm's: a notarized node can make every child process wait 30 seconds or more. [`docs/testing.md`](docs/testing.md) explains that, and what the failure kinds at the end of `pnpm test` mean.

### Where to look

| Path | What |
|---|---|
| `apps/desktop` | Electron shell; `tomrade.yml` is the application, one row per plugin |
| `packages/ui` | React 19 renderer (TanStack Router/Query, Tailwind); strings in `src/lib/i18n-messages/` |
| [`packages/*`](packages/README.md) | the core and its plugins: items, storage, agent engines, MCP, files, notes, … The linked table gives each one's role and `ctx` key |
| [`docs/architecture.md`](docs/architecture.md) | product decisions, what we deliberately don't do, the package map, data model and write path |
| [`docs/plugin-api.md`](docs/plugin-api.md) | the plugin contract |
| [`CONTEXT.md`](CONTEXT.md) | the domain language: ticket, delivery, code link, sync back, … |

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup and the details; report a vulnerability privately as [`SECURITY.md`](SECURITY.md) says. A few house rules:

- **Plugins first.** If a feature can be a plugin, make it one; the core reads contracts only.
- **Every user-facing string goes through `t(...)`**, with both an English and a Chinese entry.
- **Short why-comments only.** The code says what; a comment says why.
- Run `pnpm typecheck` and `pnpm test:related` before opening a pull request.

Tomrade is built with Tomrade. The maintainer's backlog lives in a Tomrade project, and the agent config checked into this repository (`.mcp.json`, `.codex/`, `.cursor/`, `.gemini/`, `CLAUDE.md`, `AGENTS.md`) points at it. Without that project on your machine the `tomrade` server simply isn't there, and your agent carries on as usual. Ticket keys in commit messages (`TOM-42: …`) are the maintainer's habit; you don't need one.

## FAQ

**Is it only for programmers?** No. The board, the assistant and Files work for a household, a trip, a thesis or a journal. Coding agents join in when a project has a repository and stay out of the way when it doesn't.

**Where is my data?** In one plain folder per project, on your machine.

**Can I turn the cat off?** Yes, in Settings, or unload the pet plugin entirely. The cat will not take it personally. Probably.

**Is there a phone app?** Not yet. Until then, message the assistant from your chat app. It answers as long as Tomrade runs on your computer, which it can keep doing in the background with every window closed. Pulling an all-nighter is the computer's job, not yours.

## License

[Apache License 2.0](LICENSE): the app, every package and the plugin SDK alike.

- Use it, change it and redistribute it, at home or at work, commercially too.
- Plugins are yours. Ship them under any license, commercial ones included.
- The one thing it doesn't grant: the Tomrade name and logo.

<p align="center"><sub>Ship more. Approve less. Be this cat. 🐱</sub></p>
