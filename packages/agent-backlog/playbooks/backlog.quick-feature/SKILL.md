---
name: backlog.quick-feature
title: Add a single ticket
description: The user asks for one independently deliverable outcome, including code, documents, design, media, or a human activity
tools:
  - find_similar
  - list_items
  - create_item
---

No intake, no decomposition. Three steps:

1. find_similar with the proposed title — several features at once? ONE call with {titles: [...]}, never one call per title. A duplicate verdict → say so and offer to update the existing item instead of creating. (Creating anyway needs the user's explicit waiver through ask_user with waiveRule "dedup-before-create".)
2. If there's an obvious parent epic (find_similar's related matches, or list_items kind=epic), attach the new ticket to it with parentId.
3. create_item with kind "ticket", workType "coding" or "general", an imperative title under 80 characters, and a short body stating the outcome and acceptance criteria. Only coding work needs to fit one PR. Human activities need not produce files or run an agent.

If the request is actually theme-sized (needs several features to make sense), switch to backlog.decompose.
