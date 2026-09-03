/**
 * The design's sample project, written through the real repositories.
 * Used by the UI harness so the rebuilt screens render against realistic data
 * without touching the user's database.
 */
const EPICS = [
  ["E1", "Multi-board architecture"],
  ["E2", "Theme token refactor"],
  ["E3", "AI panel"],
  ["E4", "MCP surface"]
];

const BOARDS = [
  { key: "bd-ui", name: "UI", icon: "i-panel", subtitle: "packages/ui" },
  { key: "bd-core", name: "Core & data", icon: "i-stack", subtitle: "packages/core" },
  { key: "bd-mcp", name: "MCP server", icon: "i-plug", subtitle: "packages/mcp" },
  { key: "bd-shell", name: "Desktop shell", icon: "i-monitor", subtitle: "apps/desktop" }
];

/** Saved views on top of the project's defaults (Backlog / Recently updated). `board` names a workstream the view is pinned to. */
const VIEWS = [
  { name: "Sprint 12", icon: "i-clock", layout: "board", board: "bd-ui", columns: ["todo", "doing", "verifying", "done"], wip: { doing: 3 }, groupBy: "epic" },
  { name: "Bugs", icon: "i-bug", layout: "board", filter: [{ field: "labels", op: "in", values: ["bug"] }], columns: ["todo", "doing", "verifying", "done"] },
  { name: "Agent writes", icon: "i-pen", layout: "table", filter: [{ field: "provenance", op: "in", values: ["ai"] }], sortBy: [{ field: "updated", dir: "desc" }] },
  { name: "Triage", icon: "i-filter", layout: "board", filter: [{ field: "priority", op: "in", values: ["0", "1", "2"] }], columns: ["backlog", "todo"] },
  { name: "By workstream", icon: "i-panel", layout: "board", columnBy: "board", sortBy: [{ field: "priority", dir: "asc" }] },
  { name: "Epics", icon: "i-stack", layout: "board", columnBy: "epic" },
  { name: "Dependencies", icon: "i-graph", layout: "graph", graph: "deps" }
];

/** Custom fields the sample project carries, and which design keys hold a value. */
const FIELDS = [
  { key: "points", name: "Story points", type: "number", values: { "TOM-142": 8, "TOM-8": 5, "TOM-31": 3, "TOM-19": 2, "TOM-23": 3, "TOM-64": 1, "TOM-77": 5, "TOM-51": 1 } },
  { key: "area", name: "Area", type: "select", options: [{ name: "Web" }, { name: "Desktop", description: "Electron shell" }, { name: "Agent" }], values: { "TOM-142": "Web", "TOM-8": "Web", "TOM-31": "Agent", "TOM-118": "Desktop", "TOM-2": "Desktop" } },
  { key: "due", name: "Due", type: "date", values: { "TOM-142": "2026-09-12", "TOM-8": "2026-09-05", "TOM-64": "2026-09-04" } },
  { key: "reviewed", name: "Reviewed", type: "checkbox", values: { "TOM-44": 1, "TOM-33": 1, "TOM-51": 1 } }
];

/** The keys the design's data uses, in ITEMS order — `blocks` is written in terms
 *  of these, and the real keys are assigned by the repository. */
const DESIGN_KEYS = ["TOM-142","TOM-8","TOM-31","TOM-19","TOM-23","TOM-64","TOM-5","TOM-77","TOM-51","TOM-12",
  "TOM-71","TOM-44","TOM-33","TOM-118","TOM-126","TOM-88","TOM-95","TOM-90","TOM-103","TOM-2","TOM-58"];

// [board, title, status, epic, priority, labels, author, ageMinutes, blocks, body]
const ITEMS = [
  ["bd-core", "Add boards, views and view_item_rank to schema.ts", "doing", "E1", 3, ["core", "sqlite"], "ai:mcp", 12, ["TOM-19", "TOM-77", "TOM-5"],
    "Boards become containers and views become slices of one board. Adds boards, views and view_item_rank, plus items.board_id as a NOT NULL reference. Dragging never changes board_id — moving work between workstreams stays a deliberate action."],
  ["bd-ui", "Replace paired Tailwind strings with :root custom properties", "doing", "E2", 4, ["ui"], "human", 60, ["TOM-23", "TOM-64", "TOM-51"],
    "design-system.ts binds roughly forty paired class strings. A third theme cannot be expressed through the .dark variant at all, and adding a matcha: prefix to every string guarantees drift the first time someone edits one side of a pair.", true],
  ["bd-ui", "AI panel: resize handle, collapse to rail, persist width", "doing", "E3", 2, ["ui"], "human", 180, [],
    "The assistant is a fixed-width aside with no resize, no collapse and no memory. Add a left-edge drag handle clamped 352–616px, a 48px collapsed rail, and persist both across sessions."],
  ["bd-core", "Auto-create a default view for existing boards", "todo", "E1", 3, ["migration"], "human", 300, [],
    "After the board/view migration every existing board needs an All work view, so no board can present as empty on first open."],
  ["bd-ui", "Add matcha to ThemePreference and the four-segment switcher", "todo", "E2", 2, ["ui"], "ai:mcp", 360, [],
    "ThemePreference gains matcha and system. Theme resolution moves from a boolean to a preference that resolves, so System can follow the OS without a second code path."],
  ["bd-ui", "Conflict banner is dark-only and unreadable in light mode", "todo", "E2", 3, ["bug"], "ai:mcp", 2, [],
    "The banner is styled dark-only, so in the light theme it renders pale amber text on a near-transparent dark wash. It is the only warning surface in the app, which makes it the worst thing to leave broken."],
  ["bd-mcp", "tomrade.list_items: accept a boardId filter", "todo", "E4", 2, ["mcp"], "human", 1440, [],
    "An agent should be able to scope a query to one workstream. Read-side only — views stay invisible to MCP, so the tool contract does not grow a second concept."],
  ["bd-core", "View rank falls back to items.rank when no per-view row", "todo", "E1", 2, ["core"], "ai:mcp", 1440, [],
    "view_item_rank is sparse — a row appears only once a human drags that item in that view. Ordering must fall back to items.rank so a fresh view is never empty-looking."],
  ["bd-ui", "Left-rail hover: dark class is missing the hover: prefix", "verifying", "E2", 3, ["bug"], "human", 240, [],
    "The rule reads hover:bg-slate-200/70 dark:bg-slate-800/60. The dark class has no hover: prefix, so in dark mode every inactive row renders permanently filled and the hover state never appears."],
  ["bd-ui", "Chat history filter is a no-op; errors reach the LLM empty", "verifying", "E3", 3, ["bug"], "ai:mcp", 420, [],
    "The history mapper uses .filter((m): m is … => true) — a type predicate that filters nothing. Error messages are therefore sent to the model as empty assistant turns."],
  ["bd-ui", "Undo toast with an inline action, six seconds", "verifying", null, 2, ["ui"], "ai:mcp", 540, [],
    "Every agent write should raise a toast carrying an inline undo for six seconds. The oplog already supports the reversal; nothing surfaces it."],
  ["bd-mcp", "Reject AI writes on human_locked items with a typed error", "done", "E4", 3, ["core", "mcp"], "human", 2880, [],
    "A write touching a human_locked field must fail with a typed error rather than merge. Human work is never silently overwritten — that is the product's stated thesis, so it belongs in the write path, not in review."],
  ["bd-shell", "Run electron-rebuild for better-sqlite3 on postinstall", "done", null, 1, ["build"], "human", 4320, [],
    "better-sqlite3 is a native module and must be rebuilt against Electron's ABI, otherwise the desktop build fails on a clean install."],
  ["bd-ui", "Command palette over boards, views, issues and actions", "backlog", null, 2, ["ui"], "human", 2880, [],
    "One palette spanning every board·view pair, every issue and every action. This becomes the primary navigation — the sidebar is for orientation, the palette is for speed."],
  ["bd-ui", "Inline column composer; retire the New Ticket modal", "backlog", null, 2, ["ui"], "ai:mcp", 2880, [],
    "Creating an issue should happen in the column, not in a modal. Enter commits, Escape cancels, and the status is inferred from the column it was typed into."],
  ["bd-core", "items.priority column and the five-level glyph", "backlog", "E1", 1, ["core"], "ai:mcp", 4320, [],
    "priority as INTEGER 0–4, rendered as a glyph that stays distinguishable without colour. Suppressed at its default value so it means something when it appears."],
  ["bd-core", "labels and item_labels tables, indexed for FTS5", "backlog", "E1", 1, ["core"], "human", 4320, [],
    "Labels back view filters, triage and search. Indexing them for FTS5 keeps filtering and full-text search on one path instead of two."],
  ["bd-ui", "Typeset transcript replaces the chat-bubble assistant", "backlog", "E3", 1, ["ui"], "human", 5760, [],
    "Chat bubbles are the most generic pattern in software and they fight a print-derived system. Set the conversation as correspondence: user turns compact and flush right, replies as full-measure body text."],
  ["bd-ui", "Context chip: show the assistant's visible scope", "backlog", "E3", 2, ["ui"], "human", 5760, [],
    "The panel should state what it can see — board, view and issue count — so a user never has to guess what a question will be answered against."],
  ["bd-ui", "Oplog ribbon in the status bar", "backlog", null, 1, ["ui"], "human", 7200, [],
    "Surface the most recent writes with their provenance, so the agent collaboration is visible at rest rather than only when something goes wrong."],
  ["bd-shell", "Drop the TanStack Start SSR shim left over from the reboot", "cancelled", null, 0, [], "human", 8640, [],
    "Dead code carried over from the pre-reboot architecture. Superseded by the Vite SPA setup; closing rather than fixing."]
];

export function seedDesignProject({ db, projects, boards, views, items, fields }) {
  const project = projects.create({
    name: "Tomrade Next",
    description: "Local-first backlog and knowledge workbench. Electron shell, in-process TypeScript backend, MCP server for coding agents.",
    keyPrefix: "TOM"
  });

  const firstBoard = boards.list(project.id)[0];
  const boardIds = new Map();
  for (const spec of BOARDS) {
    boardIds.set(spec.key, boards.create({ projectId: project.id, name: spec.name, icon: spec.icon, subtitle: spec.subtitle }).id);
  }
  // the seeded "Main" workstream is redundant once the four real ones exist
  if (firstBoard) boards.remove(firstBoard.id);

  const fieldIds = new Map();
  const optionIds = new Map();
  for (const spec of FIELDS) {
    const def = fields.create({ projectId: project.id, name: spec.name, type: spec.type, options: spec.options });
    fieldIds.set(spec.key, def.id);
    for (const o of def.options) optionIds.set(`${spec.key}:${o.name}`, o.id);
  }

  // the named views go after the defaults, so the project still opens on its plain Board
  for (const v of VIEWS) {
    const filter = [...(v.board ? [{ field: "board", op: "in", values: [boardIds.get(v.board)] }] : []), ...(v.filter ?? [])];
    views.create({
      projectId: project.id,
      name: v.name,
      icon: v.icon,
      layout: v.layout,
      query: { filter, columnBy: v.columnBy ?? "status", columns: v.columns ?? [], groupBy: v.groupBy ?? null, sortBy: v.sortBy ?? [], wip: v.wip ?? {}, graph: v.graph ?? null }
    });
  }

  const epicIds = new Map();
  const epicAge = 10080; // a week back, so an epic never reads as the newest write
  for (const [key, title] of EPICS) {
    const epic = items.create({ projectId: project.id, boardId: boardIds.get("bd-core"), title, kind: "epic", status: "doing", priority: 3, by: "human" });
    epicIds.set(key, epic.id);
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(Date.now() - epicAge * 60_000, epic.id);
    db.prepare("UPDATE oplog SET at = ? WHERE entity_id = ?").run(Date.now() - epicAge * 60_000, epic.id);
  }

  const byTitle = new Map();
  const created = [];
  for (const [board, title, status, epic, priority, labels, by, ageMinutes, , body, locked] of ITEMS) {
    const item = items.create({
      projectId: project.id,
      boardId: boardIds.get(board),
      title,
      body,
      status,
      priority,
      labels,
      parentId: epic ? epicIds.get(epic) : null,
      rank: created.length,
      by
    });
    if (locked) items.update(item.id, { humanLocked: true }, "human");
    byTitle.set(title, item);
    created.push({ item, ageMinutes });
  }

  const byDesignKey = new Map(ITEMS.map((row, i) => [DESIGN_KEYS[i], byTitle.get(row[1])]));
  for (const spec of FIELDS) {
    for (const [designKey, raw] of Object.entries(spec.values)) {
      const item = byDesignKey.get(designKey);
      if (!item) continue;
      const value = spec.type === "select" ? optionIds.get(`${spec.key}:${raw}`) : raw;
      items.update(item.id, { fields: { [fieldIds.get(spec.key)]: value } }, "human");
    }
  }
  ITEMS.forEach((row, i) => {
    const from = byDesignKey.get(DESIGN_KEYS[i]);
    for (const key of row[8] ?? []) {
      const to = byDesignKey.get(key);
      if (from && to) items.addRelation(from.id, to.id);
    }
  });

  // backdate so the cards print the ages the design shows
  const now = Date.now();
  for (const { item, ageMinutes } of created) {
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now - ageMinutes * 60_000, item.id);
    db.prepare("UPDATE oplog SET at = ? WHERE entity_id = ?").run(now - ageMinutes * 60_000, item.id);
  }

  const legacy = projects.create({
    name: "Tomrade Legacy",
    description: "The pre-reboot design — Supabase, FastAPI and TanStack Start. Kept read-only for reference; superseded by the local-first architecture.",
    keyPrefix: "TLG"
  });
  projects.update(legacy.id, { archived: true });

  // creating and retiring the placeholder board is fixture setup, not history
  db.prepare("DELETE FROM oplog WHERE entity = 'board'").run();

  return { project, boardIds, fieldIds };
}
