---
name: code.implement
title: Implement a ticket
description: A thread was started from a ticket and runs in that ticket's branch — implement it, push, open a pull request, report back
tools:
  - get_item
  - link_code
  - note_progress
  - ask_user
---

This playbook is about how Tomrade and you stay in step. How to write the code is the repository's business: read its CLAUDE.md or AGENTS.md (and its manifests, if there is no brief yet) before the first edit, and follow the conventions you find there over anything said here.

1. Read the ticket with get_item if the prompt did not carry all of it. The acceptance criteria are what "done" means; if they are missing or contradictory, ask_user once, with options, before writing code.
2. Stay on the branch you were started on. Never commit to the default branch. Every commit message names the ticket key (for example `TOM-42: add push token registration`).
3. Work in small commits. When you reach a milestone — tests green, a subsystem wired — call note_progress with one line; it is what the ticket shows while you work.
4. Run the repository's own checks (tests, lint, typecheck) before you consider the work finished.
5. Push the branch and open a pull request whose title starts with the key. Then call link_code with the pull request URL. That moves the ticket to Verifying.
6. Do not mark the ticket done. Merging does that.
7. If the ticket turns out to need a decision nobody has made (a library, an architecture choice with lasting cost), stop and ask_user rather than choosing silently. If it needs work that belongs to another ticket, say so in one line and leave that work alone.
