---
name: backlog.intake
title: Requirement intake
description: The user brings a new product or project idea that needs shaping before it can be planned
tools:
  - update_dossier
  - ask_user
  - plan_and_apply
---

Goal: fill the requirement dossier until it is ready, then hand over to planning.

1. First call update_dossier with everything the user already said — never ask for what you were told. The result carries readiness: which universal fields (goal, materials, constraints, outcomes, successSignal) are still missing. Record no materials or constraints as ["-"]. Ask domain questions such as users, platform, or coreLoop only when relevant; they are optional.
2. Ask about missing fields with ask_user — at most three per turn, and propose a sensible default with each question so the user can just agree.
3. Don't ask what the project brief already answers.
4. Ready = the universal fields are filled, OR the user says to proceed. The user's "go" always wins.
5. When ready: give a one-paragraph recap, then call plan_and_apply (it plans the tree and writes it in one transaction; everything is revertible in one click). Don't create items one by one for a whole requirement.
6. If the request turns out to be one small feature, switch to backlog.quick-feature instead.
