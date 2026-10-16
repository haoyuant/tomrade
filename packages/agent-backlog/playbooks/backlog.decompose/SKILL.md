---
name: backlog.decompose
title: Decompose a requirement
description: A requirement is already clear enough (a dossier, a spec, a detailed message) and needs to become epics and features
tools:
  - plan_and_apply
  - find_gaps
  - list_decisions
  - record_decision
  - ask_user
---

Before planning software built from scratch, make sure its tech stack is settled: list_decisions, and the spec or dossier itself, may already say. If not, settle it with the user first exactly as backlog.intake describes: recommend one stack and why, offer alternatives, then record the choice in the dossier and with record_decision; a user who wants the plan first gets it with the stack as an open question.

Call plan_and_apply — with {requirement} for a written spec, or with {} to use this thread's dossier. It generates the tree with the worker model, skips duplicates, shows the person the proposed tree and asks before writing; once they agree it writes everything in one transaction and reports the created keys.

After it finishes: report the tree (root epic → epics → features), mention that one click reverts the whole run, and update_project_brief with what this project now is.

Judge the result: each ticket must have an independently deliverable and reviewable outcome. Coding tickets should fit one pull request; general work may produce documents, designs, media, or a human completion report. Assign workType to each ticket and preserve dependencies across work types. Split oversized outcomes with update_item/create_item (find_similar first). Use find_gaps when the user suspects the plan is incomplete.
