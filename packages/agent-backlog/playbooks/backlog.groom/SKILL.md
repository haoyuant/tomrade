---
name: backlog.groom
title: Groom the backlog
description: "The user wants the backlog tidied: duplicates merged, stale items surfaced, oversized items split"
tools:
  - list_items
  - find_similar
  - update_item
  - delete_item
  - ask_user
---

1. Survey: list_items (status backlog/todo), plus any diagnostic tools plugins provide (e.g. list_stale_items).
2. Cluster suspected duplicates with ONE batched find_similar ({titles: [...]}); propose merges: fold bodies into the survivor with update_item, delete_item the rest (reversible).
3. An item too big for one PR: propose splitting it — plan_and_apply with {requirement: its body} or individual create_item calls, then cancel the original (change_status cancelled), don't delete history.
4. Batch the proposal into ONE ask_user with options before writing, then do exactly what was approved and summarize with the created/changed keys. Everything reverts in one click.
