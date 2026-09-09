---
name: code.implement
title: Implement a ticket
description: A thread was started from a ticket and runs in that ticket's branch — implement it, push, open a pull request, report back
tools:
  - get_item
  - list_decisions
  - record_decision
  - link_code
  - note_progress
  - ask_user
---

This playbook is about how Tomrade and you stay in step. How to write the code is the repository's business: read its CLAUDE.md or AGENTS.md (and its manifests, if there is no brief yet) before the first edit, and follow the conventions you find there over anything said here.

0. Pre-flight, before the first edit: call list_decisions and read the repository's CLAUDE.md. Name the cross-cutting areas this ticket touches (state management, routing, persistence, auth, deployment shape, a new dependency with lasting cost). For any such area with no accepted decision and more than one defensible option, do not choose silently: ask_user with the options, then record_decision with what was chosen and why. Cheap, local choices need no note.
1. Read the ticket with get_item if the prompt did not carry all of it. The acceptance criteria are the complete scope and what "done" means. Neighboring tickets are context and dependencies, not permission to implement them. If the criteria are missing or contradictory, ask_user once, with options, before writing code.
2. Before the first edit, state the smallest behavior and files you expect to change. This session owns exactly one ticket. Do not add an adjacent ticket's data model, screen, flow, API, refactor, or cleanup. If another ticket is required, call note_progress with that dependency and leave it untouched for a separate branch and session.
3. Stay on the branch you were started on. Never commit to the default branch. Every commit message names the ticket key (for example `TOM-42: add push token registration`).
4. Work in small commits. When you reach a milestone — tests green, a subsystem wired — call note_progress with one line; it is what the ticket shows while you work.
5. Run the repository's own checks (tests, lint, typecheck) before you consider the work finished.
6. Before pushing, review the complete diff against the default branch, map every changed file and behavior to an acceptance criterion, and remove anything that does not map. Push and open a pull request whose title starts with the key. Then call link_code with the pull request URL and `scopeChecked: true`. That moves the ticket to Verifying.
7. Do not mark the ticket done. Merging does that.
8. If the ticket turns out to need a decision nobody has made (a library, an architecture choice with lasting cost), stop and ask_user rather than choosing silently.
9. If `git push`, `git fetch`, `git pull` or `gh` fails with an authentication or "repository not found" error, do not switch accounts, edit credential helpers or change the remote. Commit locally, call note_progress with `blocked: push …`, and stop — the human owns credentials.
