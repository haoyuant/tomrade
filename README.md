<p align="center">
  <img src="docs/images/banner.png" alt="Tomrade: the cat on a red rising sun. From idea to delivery, side by side. No babysitting; a backlog that lasts; see it, undo it; for everyday tasks too." width="820">
</p>

<p align="center">
  <a href="https://tomrade.com">Website</a> ·
  <a href="https://tomrade.com/download">Download</a> ·
  <a href="#connect-your-agents">Connect your agents</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="https://github.com/haoyuant/tomrade-plugins">Plugins</a> ·
  <a href="#support">💖 Support</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-a83c32"></a>
  <img alt="Platforms: macOS, Windows, Linux" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-5b4636">
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-d9a441">
</p>

# Tomrade

**From idea to delivery, side by side.**

Tickets, terminals, sessions, notes: Tomrade weaves together everything you need and reports in on its own. You? Smooth sailing. It's a local-first workspace for indie developers and small teams who build with AI agents (Claude Code, Codex and the rest) and run their days with them.

- **No babysitting.** Agents claim their tickets, branch, and report back on their own. They only come to you when they need your call.
- **A backlog that lasts.** Ideas, tickets, decisions and what's done stay in one place across sessions and agents, so the next run starts where the last one stopped.
- **Keep the tools you have.** Your agents stay in the terminal you already use. Tomrade connects over MCP and git, and the board keeps up on its own.
- **See it, undo it.** Every agent write is attributed and grouped by run. One click takes a whole run back.
- **All in one place.** Files and notes, everyday to-dos and an inbox of feedback live beside your tickets, and your agents can read them too.

<p align="center">
  <a href="https://tomrade.com/#films"><img src="docs/images/film.jpg" alt="Play the 87-second film: one idea becomes linked tickets, agents ask their questions, an auto run works through the night, and one click undoes it all." width="820"></a><br>
  <sub>A day with Tomrade, filmed in the app. More short films are on <a href="https://tomrade.com/#films">tomrade.com</a>.</sub>
</p>

<p align="center">
  <img src="docs/images/board.png" alt="Tomrade's board: a sidebar of views and workstreams, ticket cards in Backlog and To Do columns, and the assistant panel on the right." width="900">
</p>

> [!NOTE]
> **Preview.** Until 1.0, Tomrade is in development and testing: things change from week to week and you will hit rough edges. Your projects are plain folders on your own disk, so back up the ones that matter.

## How it works

One loop from an idea to a merged pull request: **talk, split, build, merge.**

1. **Talk.** Say what you want in plain words, at your desk or from your phone. It becomes a ticket on the board.
2. **Split.** Say "tidy up" and the assistant merges duplicates and splits the big ones into tickets sized for one pull request. One click takes it back.
3. **Build.** Press **Start**, or name the ticket to your agent in your own terminal. It claims the ticket, works on its own branch and reports back.
4. **Merge.** Once the checks pass, take a look and press **Merge**, or let the agent merge it itself. An auto run does this overnight down the dependency graph and leaves you a report by morning.

## What's in it

- **🌙 Auto run.** Pick tickets on the dependency graph, set the limits (how many at once, how much to spend), and go to bed. Nothing merges unless you said so and its checks pass.
- **🖥️ A terminal window beside the board.** Split panes for Claude Code, Codex or a shell; each pane says whether it's running or needs you, and agents keep working after you quit. Built on [herdr](https://herdr.dev); on Windows it runs on Tomrade's own backend.
- **💬 An assistant for anything in Tomrade.** Tickets, files, notes, settings: ask in plain words. Every change it makes is attributed and undoable.
- **📓 Files and notes.** A folder per project with Markdown, `[[wiki links]]`, `#tags`, full-text search, a daily journal and version history that can sync to GitHub.
- **📱 Chat from your phone.** Talk to the assistant from Discord, Slack, Telegram, Feishu / Lark, DingTalk or WeCom, straight from your computer with no server of ours in between.
- **📥 An inbox for feedback.** GitHub issues and other sources land in an inbox first; the assistant sorts them and drafts the reply, and you confirm.
- **✏️ Diagrams in one sentence.** [Archify](https://github.com/tt-a1i/archify) is built in: architecture, workflow, sequence and more, as live pages you edit by asking.
- **🧩 Everything is a plugin.** Storage, tools, the MCP server, the assistant: each one swappable. Write your own against the Apache-2.0 SDK, or have an agent write it in Plugin Studio. Official plugins live in [tomrade-plugins](https://github.com/haoyuant/tomrade-plugins).
- **🐱 And a cat.** A desktop pet that shows what your agent is doing, and a pomodoro in the status bar.

**Not just for code.** Every project is a board plus a folder: connect a repository, or fill it with your week. Errands, a journal, docs, and routines (a daily to-do, the week's chores) that run on a schedule.

**Built so agents can move fast without stepping on you.** Your project folder is the truth and SQLite only a cache. Fields you lock stay locked, and a write based on a stale read is refused. Bring your own model (DeepSeek, Anthropic, OpenAI, Gemini, Kimi, OpenRouter, any OpenAI-compatible or local model) or let your own Claude Code or Codex conduct. No account is needed; anonymous usage statistics have their own switch in Settings, and [Data use and privacy](docs/data-privacy.md) lists exactly what they contain.

## Install

Free, on macOS, Windows and Linux: **[tomrade.com/download](https://tomrade.com/download)** or the [GitHub releases](https://github.com/haoyuant/tomrade/releases).

| System | Installer | Notes |
|---|---|---|
| macOS 12+ (Apple silicon or Intel) | `.dmg` | Signed and notarized. |
| Windows 10 / 11, 64-bit | `.exe` | Not code-signed yet: **More info → Run anyway**. Read the [download page](https://tomrade.com/download) first if Smart App Control is on. See the [code signing policy](https://tomrade.com/code-signing/). |
| Linux, x86-64 or arm64 | `.AppImage` | `chmod +x` and run; with no FUSE at all, add `--appimage-extract-and-run`. |

It checks for updates and installs one only when you say so. The interface speaks English, 简体中文, 繁體中文, 日本語, Español, Deutsch, Français and Русский.

## Connect your agents

Tomrade runs an MCP server at `http://127.0.0.1:19090/mcp`, on 127.0.0.1 only.

**The easy way:** in a project, open a repository and connect coding agents, for this machine only or for the team as a pull request. Tomrade writes the config for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, WorkBuddy and Pi, plus notes on how to claim a ticket and sync back. Details: [`docs/agent-connections.md`](docs/agent-connections.md).

**By hand**, for any agent that speaks Streamable HTTP MCP:

```sh
claude mcp add --transport http tomrade http://127.0.0.1:19090/mcp
```

```json
{ "mcpServers": { "tomrade": { "type": "http", "url": "http://127.0.0.1:19090/mcp" } } }
```

Your agent gets the assistant's tools (`list_items`, `create_item`, `claim_ticket`, `link_code`, `search_files`, …) and follows the same rules: attributed, versioned, undoable.

## Support

I build Tomrade on my own, after work, and it's free. The agents do most of the work now, and they eat tokens buffet-style. Your support turns into tokens, tokens into PRs, PRs into next week's release.

- 💖 [GitHub Sponsors](https://github.com/sponsors/haoyuant)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/tomrade)
- ⚡ [Afdian (爱发电)](https://afdian.com/a/haoyuant)
- Alipay / WeChat Pay:

<p>
  <img src="docs/images/support/alipay.png" alt="Alipay QR code" height="200">
  <img src="docs/images/support/wechat.png" alt="WeChat Pay QR code" height="200">
</p>

Can't chip in? Open an issue or tell a friend; that helps too.

## Build from source

You need Node.js (CI uses 26) and pnpm 11 (`corepack enable` picks the pinned version).

```sh
git clone https://github.com/haoyuant/tomrade.git
cd tomrade
pnpm install
pnpm dev          # builds the backend, then Vite + Electron
```

A checkout run with `pnpm dev` keeps its own data and serves MCP on port **19091**, so it runs beside an installed Tomrade.

```sh
pnpm typecheck     # the backend, then the UI
pnpm test          # vitest across every package
pnpm test:related  # only the tests your changes reach
pnpm --filter @tomrade/desktop package   # installers
```

Where to look: `apps/desktop` (the Electron shell), `packages/ui` (the React renderer), [`packages/*`](packages/README.md) (the core and its plugins), [`docs/architecture.md`](docs/architecture.md), [`docs/plugin-api.md`](docs/plugin-api.md), [`docs/testing.md`](docs/testing.md) and [`CONTEXT.md`](CONTEXT.md) (the domain language).

## Contributing

Issues and pull requests are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md), and report a vulnerability privately as [`SECURITY.md`](SECURITY.md) says. In short: make it a plugin if it can be one, send every user-facing string through `t(...)` in English and Chinese, keep comments to the why, and run `pnpm typecheck` and `pnpm test:related` before a pull request.

Tomrade is built with Tomrade: the agent config in this repository points at the maintainer's backlog, and without it your agent simply carries on. Thanks to [the people who shaped Tomrade](https://tomrade.com/thanks/).

## FAQ

**Is it only for programmers?** No. The board, the assistant and Files work for any project: a household, a trip, a thesis, a journal.

**Where is my data?** In one plain folder per project, on your machine. An account only syncs your preferences and project list.

**Is there a phone app?** It's on the way. Until then, message the assistant from your chat app while Tomrade runs on your computer.

## License

[Apache License 2.0](LICENSE): the app, every package and the plugin SDK. Use it, change it and ship it, commercially too; plugins are yours under any license. The Tomrade name and logo are not included.

<p align="center"><sub>Ship more. Approve less. Be this cat. 🐱</sub></p>
