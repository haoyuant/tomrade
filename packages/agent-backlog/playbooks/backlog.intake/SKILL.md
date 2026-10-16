---
name: backlog.intake
title: Requirement intake
description: The user brings a new product or project idea that needs shaping before it can be planned
tools:
  - update_dossier
  - ask_user
  - list_decisions
  - record_decision
  - plan_and_apply
---

Goal: fill the requirement dossier until it is ready, then hand over to planning.

1. First call update_dossier with everything the user already said — never ask for what you were told. The result carries readiness: which universal fields (goal, materials, constraints, outcomes, successSignal) are still missing. Record no materials or constraints as ["-"]. Ask domain questions such as users, platform, or coreLoop only when relevant; they are optional.
2. Ask about missing fields with ask_user — at most three per turn, and propose a sensible default with each question so the user can just agree.
3. Don't ask what the project brief already answers.
4. Ready = the universal fields are filled (and, for software built from scratch, the stack is settled or explicitly deferred — see below), OR the user says to proceed. The user's "go" always wins.
5. When ready: give a one-paragraph recap, then call plan_and_apply (it plans the tree, shows it to the person and writes it in one transaction once they agree; everything is revertible in one click). Don't create items one by one for a whole requirement.
6. If the request turns out to be one small feature, switch to backlog.quick-feature instead.

Software built from scratch (a new app, site, service or tool, rather than work inside an existing codebase) settles its tech stack before planning, because the stack shapes the tickets:
- list_decisions first: a stack already on record is settled, and so is the stack of a codebase the user names. Don't ask again.
- Otherwise ask with ask_user, together with the platform if that is still open. Put your recommended stack first, with one line on why it fits this goal, platform, constraints and the user's experience; add one or two genuine alternatives and "You choose for me". Cover only the costly-to-reverse layers (language and framework, backend or data store when there is one); leave tooling to the bootstrap.
- When the user has no preference or asks for advice, recommend one stack and say why in a sentence or two; don't make them design it.
- Record the confirmed choice twice: in the dossier (platform, and decisions as {what, why}) and with record_decision, naming its areas (e.g. ["language", "framework", "database"]), so the repository's bootstrap and every coding ticket inherit it.
- If the user wants the plan before deciding, plan anyway: note the stack as an open question, and keep tickets stack-neutral.
