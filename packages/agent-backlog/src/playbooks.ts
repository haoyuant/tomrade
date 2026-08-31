/** The four backlog playbooks. SKILL.md-shaped: `when` is the index line, the body loads on open_playbook. */
export const PLAYBOOKS = [
  {
    id: "backlog.intake",
    title: "Requirement intake",
    when: "The user brings a new product or project idea that needs shaping before it can be planned",
    tools: ["update_dossier", "ask_user", "plan_and_apply"],
    body: `Goal: fill the requirement dossier until it is ready, then hand over to planning.

1. First call update_dossier with everything the user already said — never ask for what you were told. The result carries readiness: which of the six required fields (goal, users, platform, coreLoop, outOfScope, successSignal) are still missing.
2. Ask about missing fields with ask_user — at most three per turn, and propose a sensible default with each question so the user can just agree.
3. Don't ask what the project brief already answers.
4. Ready = all six filled, OR the user says to proceed. The user's "go" always wins.
5. When ready: give a one-paragraph recap, then call plan_and_apply (it plans the tree and writes it in one transaction; everything is revertible in one click). Don't create items one by one for a whole requirement.
6. If the request turns out to be one small feature, switch to backlog.quick-feature instead.`
  },
  {
    id: "backlog.decompose",
    title: "Decompose a requirement",
    when: "A requirement is already clear enough (a dossier, a spec, a detailed message) and needs to become epics and features",
    tools: ["plan_and_apply", "find_gaps"],
    body: `Call plan_and_apply — with {requirement} for a written spec, or with {} to use this thread's dossier. It generates the tree with the worker model, skips duplicates, writes everything in one transaction, and reports the created keys.

After it finishes: report the tree (root epic → epics → features), mention that one click reverts the whole run, and update_project_brief with what this project now is.

Judge the result: a feature that cannot be one pull request should be split — say so and fix it with update_item/create_item (find_similar first). Use find_gaps when the user suspects the plan is incomplete.`
  },
  {
    id: "backlog.quick-feature",
    title: "Add a single feature",
    when: "The user asks for one concrete, PR-sized capability — not a whole product or theme",
    tools: ["find_similar", "list_items", "create_item"],
    body: `No intake, no decomposition. Three steps:

1. find_similar with the proposed title. A duplicate verdict → say so and offer to update the existing item instead of creating. (Creating anyway needs the user's explicit waiver through ask_user with waiveRule "dedup-before-create".)
2. If there's an obvious parent epic (find_similar's related matches, or list_items kind=epic), attach the new ticket to it with parentId.
3. create_item with kind "ticket", an imperative title under 80 characters, a 1–3 sentence body.

If the request is actually theme-sized (needs several features to make sense), switch to backlog.decompose.`
  },
  {
    id: "backlog.groom",
    title: "Groom the backlog",
    when: "The user wants the backlog tidied: duplicates merged, stale items surfaced, oversized items split",
    tools: ["list_items", "find_similar", "update_item", "delete_item", "ask_user"],
    body: `1. Survey: list_items (status backlog/todo), plus any diagnostic tools plugins provide (e.g. list_stale_items).
2. Cluster suspected duplicates with find_similar; propose merges: fold bodies into the survivor with update_item, delete_item the rest (reversible).
3. An item too big for one PR: propose splitting it — plan_and_apply with {requirement: its body} or individual create_item calls, then cancel the original (change_status cancelled), don't delete history.
4. Batch the proposal into ONE ask_user with options before writing, then do exactly what was approved and summarize with the created/changed keys. Everything reverts in one click.`
  }
] as const;
