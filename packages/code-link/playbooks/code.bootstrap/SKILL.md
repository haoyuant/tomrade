---
name: code.bootstrap
title: Bootstrap a repository
description: The repository is empty or has no project in it yet — settle the stack with the user, scaffold it, write CLAUDE.md, open the first pull request
tools:
  - get_item
  - list_items
  - list_decisions
  - record_decision
  - ask_user
  - link_code
  - note_progress
---

An empty repository has decisions in it that every later ticket will inherit. This playbook makes them explicit, once, with the user — then lays down the smallest scaffold that lets the next ticket start.

1. Read the ticket and the backlog (list_items) to learn what is going to be built here. The other tickets say what the stack has to carry.
2. List the cross-cutting choices this repository needs: language and framework, state management or routing where the platform has several idioms, package manager, test runner, formatter, CI, deployment shape. For each, propose a default and the one strongest alternative in a short line.
3. Ask the user to confirm or change them with ask_user — a few questions at most, options not prose. Costly-to-reverse choices are theirs; cheap ones you may decide and record.
4. Scaffold: initialize the project with its own tooling, add build / test / lint commands that run, and a CI workflow that runs them.
5. Write CLAUDE.md and AGENTS.md at the repository root: what this is, the stack and why (one line per decision), how to build and test, the folder layout, and the Tomrade conventions — branches named `<key>/<slug>` in lowercase, commit messages naming the key, pull requests titled with the key. If the prompt gave you a Tomrade MCP URL, configure it as `tomrade` in both Claude Code's `.mcp.json` and Codex's `.codex/config.toml`.
6. Record each decision twice: record_decision puts it in the project's own notes (`.tomrade/docs/decisions/`, shared across this project's repositories), and a short ADR-style copy under `docs/decisions/` in the repository keeps it beside the code.
7. Commit on the ticket's branch with messages naming the key, push, open a pull request, and call link_code with its URL. Once it merges, the repository counts as scaffolded and the tickets it blocked are free to start.
