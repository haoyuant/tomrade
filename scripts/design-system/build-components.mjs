// Writes components/<Comp>/README.md + preview.html for the Tomrade Ledger system.
// Markup mirrors the React components in packages/ui/src/components; styling is components/bundle.css.
// usage: node build-components.mjs <dsOut>
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
const I = (id, size = 14, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} width="${size}" height="${size}" aria-hidden="true"><use href="../icons.svg#${id}"/></svg>`;
const doc = (marker, body, bodyStyle = "") => `${marker}
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>preview</title></head>
<body style="height:auto;overflow:visible;margin:0;padding:20px;background:var(--bg);${bodyStyle}">
${body}
</body>
</html>
`;
const row = (inner, gap = 10) => `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:${gap}px">${inner}</div>`;
const col = (inner, gap = 14) => `<div style="display:flex;flex-direction:column;gap:${gap}px">${inner}</div>`;
const label = (t) => `<p class="eyebrow" style="margin:0 0 6px">${t}</p>`;

const card = ({ key, title, status = "s-todo", prio = null, ws = null, date = "2d", epic = null, hue = 250, tags = [], prov = null, selected = false, done = false }) => `<div class="card" role="button" tabindex="0"${selected ? ' data-selected="true"' : ""}>
  <span class="card-gutter">${prov === "ai" ? '<span class="prov-tick" style="height:17px"></span>' : prov === "lock" ? I("i-lock", 12, "prov-lock") : ""}</span>
  <span class="card-body">
    <span class="card-meta">${I(status, 12, done ? "sdot done" : "sdot")}${prio ? I(prio, 12, prio === "p-4" ? "prio urgent" : "prio") : ""}<span class="card-id">${key}</span>${ws ? `<span class="card-board">${I(ws[0], 11)}${ws[1]}</span>` : ""}<span class="card-date">${date}</span></span>
    <span class="card-title">${title}</span>
    ${epic || tags.length ? `<span class="card-foot">${epic ? `<span class="tag card-epic" style="--epic-hue:${hue}">${I("i-stack", 11)}<span class="card-epic-name">${epic}</span></span>` : ""}${tags.map((t) => `<span class="tag ${t[1] ?? "neutral"}">${t[0]}</span>`).join("")}</span>` : ""}
  </span>
</div>`;

const C = {};

C.Button = {
  group: "Actions", height: 200, subtitle: "primary · secondary · ghost · icon · danger · kbd",
  readme: `# Button

The one control for actions: \`.btn\` plus a variant, set in the display face at \`--text-sm\` with \`--tracking-label\`.

## Variants
- \`.btn.btn-primary\`: the solid \`accent\` fill. **One solid button per viewport, per action.** Hover moves to \`accent-active\` in the same rule. While an overlay is open, the titlebar's primary drops to the secondary look so the dialog's confirm is the only solid fill.
- \`.btn.btn-secondary\`: \`surface-warm\` with \`elev-ring\`; the second action in a sheet ("Set local repository…").
- \`.btn.btn-ghost\`: no fill, \`muted\` text; titlebar and status-bar actions (Search, Auto run, Undo).
- \`.btn.btn-icon\`: a 6px-padded square for an icon alone. Always give it \`aria-label\` (and \`data-tip\` for the quick tooltip). Add \`.is-danger\` for a destructive icon that only turns red on hover.
- \`.btn.btn-danger\`: the only place \`danger\` is a fill: the confirm button of a purge or project delete.
- \`.link-btn\`: an inline text action in \`accent\`.
- \`.kbd\`: a key cap beside a label (\`⌘K\`); hidden in the titlebar under 960px.

## The consumer provides
A label (sentence case, a verb: "New", "Start", "Set local repository…"; an ellipsis when it opens a dialog), an optional 14–17px icon from the sprite before it, and \`disabled\` when the action can't run (45% opacity).

## Don't
- Don't put two \`btn-primary\` in one view.
- Don't colour a button to signal state; state lives in marks and words.
`,
  preview: doc(`<!-- @dsCard group="Actions" height=200 subtitle="primary · secondary · ghost · icon · danger · kbd" -->`, col(
    row(`<button class="btn btn-primary">${I("i-plus")}New</button><button class="btn btn-secondary">Set local repository…</button><button class="btn btn-ghost">${I("i-search")}<span>Search</span><span class="kbd">⌘K</span></button><button class="btn btn-ghost">${I("i-moon", 15)}Auto run</button>`) +
    row(`<button class="btn btn-icon" aria-label="Settings">${I("i-gear", 17)}</button><button class="btn btn-icon" aria-label="Usage">${I("i-bars", 17)}</button><button class="btn btn-icon is-danger" aria-label="Delete">${I("i-trash")}</button><button class="btn btn-icon" aria-label="Expand">${I("i-expand")}</button><button class="btn btn-icon" aria-label="Close">${I("i-close")}</button><span style="width:12px"></span><button class="btn btn-danger">Delete permanently</button><button class="btn btn-secondary" disabled>Disabled</button><button class="link-btn">Open in Files</button>`)
  )),
};

C.Seg = {
  group: "Actions", height: 120, subtitle: "solid · quiet",
  readme: `# Seg

A segmented control: one choice among two to five, all visible. \`.seg\` holds plain \`<button>\`s with \`aria-pressed\`.

- \`.seg\` (solid): the pressed segment takes the \`accent\` fill. Used for settings choices: theme, language, density.
- \`.seg.quiet\`: the pressed segment takes \`tag-bg-base\` / \`tag-fg\`. Used inside the board head for the layout switch (Board · Table · Graph) so it never competes with the titlebar's primary.

The consumer provides the options, the pressed one, and an \`.ico\` icon per option when the labels can drop at narrow widths (\`.seg-lbl\` hides under 700px of board).
`,
  preview: doc(`<!-- @dsCard group="Actions" height=120 subtitle="solid · quiet" -->`, col(
    row(`<div class="seg" role="group" aria-label="Theme"><button aria-pressed="true">Sunrise</button><button aria-pressed="false">Daybreak</button><button aria-pressed="false">Glass</button><button aria-pressed="false">Sakura</button></div>`) +
    row(`<div class="seg quiet" role="group" aria-label="Layout"><button aria-pressed="true">${I("i-board", 14, "ico")}<span class="seg-lbl">Board</span></button><button aria-pressed="false">${I("i-bars", 14, "ico")}<span class="seg-lbl">Table</span></button><button aria-pressed="false">${I("i-graph", 14, "ico")}<span class="seg-lbl">Graph</span></button></div>`)
  )),
};

C.Switch = {
  group: "Actions", height: 96, subtitle: "off · on · disabled",
  readme: `# Switch

An on/off setting that applies at once. \`<button class="switch" role="switch" aria-checked>\`: \`surface-warm\` track when off, \`accent\` when on, the knob in \`accent-on\`.

The consumer provides the label beside it (a settings row) and the checked state. Use a Checkbox instead for a choice inside a list or a form that is saved later.
`,
  preview: doc(`<!-- @dsCard group="Actions" height=96 subtitle="off · on · disabled" -->`, row(
    `<label style="display:flex;align-items:center;gap:10px;font-size:14px;color:var(--fg-2)"><button class="switch" role="switch" aria-checked="true" aria-label="Check for updates"></button>Check for updates automatically</label><label style="display:flex;align-items:center;gap:10px;font-size:14px;color:var(--fg-2)"><button class="switch" role="switch" aria-checked="false" aria-label="Beta"></button>Beta channel</label><button class="switch" role="switch" aria-checked="false" disabled aria-label="Unavailable"></button>`, 24)),
};

C.Checkbox = {
  group: "Actions", height: 96, subtitle: "off · on · disabled",
  readme: `# Checkbox

A native \`<input type="checkbox">\`, restyled to follow the Switch rather than the OS: \`surface\` inside \`elev-ring\` when off, \`accent\` with the tick cut in \`accent-on\` when on.

Use it for multiple choice in lists and forms (pinning files to a ticket, fields shown on a card). Always pair it with a \`<label>\`.
`,
  preview: doc(`<!-- @dsCard group="Actions" height=96 subtitle="off · on · disabled" -->`, row(
    ["Status", "Priority", "Labels"].map((t, i) => `<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--fg-2)"><input type="checkbox" id="cb${i}"${i < 2 ? " checked" : ""}>${t}</label>`).join("") + `<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--meta)"><input type="checkbox" id="cb9" disabled>Story points</label>`, 22)),
};

C.Input = {
  group: "Forms", height: 260, subtitle: "input · select · textarea · field",
  readme: `# Input

Text entry: \`.input\`, \`.textarea\` and \`.select\` share one box: \`surface\` fill, a 1px \`border-input\` edge (3:1 against the page), \`--radius-md\`, the display face at 14px. Focus turns the edge \`accent\` and adds \`focus-ring\`.

Wrap a control in \`.field\` with a \`<label>\` (uppercase eyebrow in \`meta\`) and an optional \`.field-note\` (\`.is-error\` in \`danger\`). Placeholders are in \`meta\` and are examples, never the label.

The select opts into \`appearance: base-select\` so its list is the design's menu on every platform.
`,
  preview: doc(`<!-- @dsCard group="Forms" height=260 subtitle="input · select · textarea · field" -->`, `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:640px">
  <div class="field"><label for="in1">Project name</label><input class="input" id="in1" value="Tomrade"><p class="field-note">Shown on the home screen and in the switcher.</p></div>
  <div class="field"><label for="in2">Local repository</label><input class="input" id="in2" placeholder="~/Projects/tomrade"><p class="field-note is-error">No git repository at that path.</p></div>
  <div class="field"><label for="in3">Work type</label><select class="select" id="in3"><option>Coding</option><option>Writing</option><option>Research</option></select></div>
  <div class="field"><label for="in4">Description</label><textarea class="textarea" id="in4">One palette spanning every board-view pair, every issue and every action.</textarea></div>
</div>`),
};

C.QueryBar = {
  group: "Forms", height: 130, subtitle: "search · filter chip · column by · swimlanes · sort · unsaved",
  readme: `# QueryBar

The bar under a view's head that edits the live query: search, filters, column by, swimlanes, sort. **The live query is the render source of truth**: the bar edits a draft, and when it differs from the saved view the \`.qb-dirty\` group appears with Discard, Save as new and Save view. Nothing saves behind the user's back.

Parts: \`.query-bar\` › \`.qb-search\` (\`/\` key cap), \`.qb-chip\` (one per filter clause, with \`.qb-chip-edit\` and \`.qb-chip-x\`), \`.qb-btn\` (with \`.ico\`, \`.lbl\`, \`.qb-val\` and \`.chev\`; \`data-on="true"\` when it narrows the view), \`.qb-right\`, \`.qb-sep\`.

The consumer provides the fields of the project and the current query.
`,
  preview: doc(`<!-- @dsCard group="Forms" height=130 subtitle="search · filter chip · column by · swimlanes · sort · unsaved" -->`, `<div class="query-bar" style="border:1px solid var(--border);border-radius:var(--radius-md)">
  <label class="qb-search">${I("i-search", 13, "ico")}<input class="qb-search-input" id="qbs" placeholder="Search tickets"><span class="kbd">/</span></label>
  <span class="qb-chip"><button class="qb-chip-edit">${I("i-tag", 12, "ico")}<span>Labels is ui</span></button><button class="qb-chip-x" aria-label="Remove filter">${I("i-close", 11)}</button></span>
  <button class="qb-btn qb-add">${I("i-filter", 13, "ico")}<span class="lbl">Filter</span>${I("i-chevdown", 12, "chev")}</button>
  <div class="qb-right">
    <button class="qb-btn qb-column-by">${I("i-board", 13, "ico")}<span class="lbl">Column by</span><span>Status</span>${I("i-chevdown", 12, "chev")}</button>
    <button class="qb-btn qb-group-by" data-on="true">${I("i-stack", 13, "ico")}<span class="lbl">Swimlanes</span><span>Epic</span>${I("i-chevdown", 12, "chev")}</button>
    <button class="qb-btn qb-sort">${I("i-bars", 13, "ico")}<span class="lbl">Sort</span><span>Manual</span>${I("i-chevdown", 12, "chev")}</button>
    <span class="qb-sep"></span>
    <div class="qb-dirty" role="group" aria-label="Unsaved changes"><button class="btn btn-ghost" style="padding:5px 9px">Discard</button><button class="btn btn-ghost" style="padding:5px 9px">Save as new</button><button class="btn btn-secondary" style="padding:5px 10px">Save view</button></div>
  </div>
</div>`),
};

C.Marks = {
  group: "Marks", height: 170, subtitle: "6 statuses · 5 priorities · provenance",
  readme: `# Marks

Status and priority are **shape-coded, not colour-coded**: each of the six statuses and five priorities is distinguishable in greyscale. Colour is confirmation, never the signal.

- **StatusMark** \`<svg class="sdot">\` using \`s-backlog\` (dashed ring), \`s-todo\` (ring), \`s-doing\` (half), \`s-verifying\` (three quarters), \`s-done\` (filled with a tick; add \`.done\` for \`success\`), \`s-cancelled\` (ring with a slash). Colour \`meta\`.
- **PriorityGlyph** \`<svg class="prio">\` using \`p-0\` (No priority, a dash), \`p-1\` Low, \`p-2\` Medium, \`p-3\` High (bar height encodes level) and \`p-4\` Urgent (a different shape; \`.urgent\` in \`danger\`). **Medium is suppressed** on cards: a glyph's presence always means something.
- **Provenance** sits in the card gutter, never as a badge: \`.prov-tick\` (2px \`accent\` tick, title-height) for an agent's write, \`.prov-tick.is-sync\` (\`meta\`) for a sync, \`i-lock\` as \`.prov-lock\` for a human-locked field. A human write gets nothing. Derived from \`updatedBy\` + \`humanLocked\`, never stored.
`,
  preview: doc(`<!-- @dsCard group="Marks" height=170 subtitle="6 statuses · 5 priorities · provenance" -->`, col(
    `<div>${label("Status")}${row([["s-backlog", "Backlog"], ["s-todo", "To Do"], ["s-doing", "Doing"], ["s-verifying", "Verifying"], ["s-done", "Done"], ["s-cancelled", "Cancelled"]].map(([id, n]) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--fg-2)">${I(id, 14, id === "s-done" ? "sdot done" : "sdot")}${n}</span>`).join(""), 18)}</div>` +
    `<div>${label("Priority")}${row([["p-0", "No priority"], ["p-1", "Low"], ["p-2", "Medium"], ["p-3", "High"], ["p-4", "Urgent"]].map(([id, n]) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--fg-2)">${I(id, 14, id === "p-4" ? "prio urgent" : "prio")}${n}</span>`).join(""), 18)}</div>` +
    `<div>${label("Provenance")}${row(`<span style="display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--fg-2)"><span class="prov-tick" style="height:17px"></span>Agent write</span><span style="display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--fg-2)"><span class="prov-tick is-sync" style="height:17px"></span>Sync</span><span style="display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--fg-2)">${I("i-lock", 12, "prov-lock")}Human-locked</span>`, 18)}</div>`
  )),
};

C.Tag = {
  group: "Marks", height: 110, subtitle: "soft · faint · strong · neutral · epic",
  readme: `# Tag

A small label in the display face at \`--text-xs\`, \`--radius-xs\`, \`tag-fg\` on a solid \`tag-bg-*\` fill (pre-blended, never rgba).

- \`.tag\` (soft), \`.tag.faint\`, \`.tag.strong\`: plugin badges such as \`blocked\`.
- \`.tag.neutral\`: labels on a card (\`ui\`, \`core\`, \`migration\`), \`surface-warm\` with \`muted\` text.
- \`.tag.card-epic\`: an epic's tag in the epic's own hue (\`--epic-hue\`, an oklch hue angle), mixed into the theme's text and surface so it reads in every theme.

A plugin badge is a tag in the card foot, never a mark in the gutter.
`,
  preview: doc(`<!-- @dsCard group="Marks" height=110 subtitle="soft · faint · strong · neutral · epic" -->`, row(
    `<span class="tag">blocked</span><span class="tag faint">draft</span><span class="tag strong">needs review</span><span class="tag neutral">ui</span><span class="tag neutral">core</span><span class="tag neutral">migration</span><span class="tag card-epic" style="--epic-hue:150">${I("i-stack", 11)}<span class="card-epic-name">Multi-board architecture</span></span><span class="tag card-epic" style="--epic-hue:300">${I("i-stack", 11)}<span class="card-epic-name">Theme token refactor</span></span><span class="tag card-epic" style="--epic-hue:60">${I("i-stack", 11)}<span class="card-epic-name">MCP surface</span></span>`, 8)),
};

C.Card = {
  group: "Board", height: 330, subtitle: "default · agent write · selected · locked · done",
  readme: `# Card

A ticket on the board: \`.card\` is a two-column grid, a 14px gutter for provenance and the body.

- \`.card-meta\`: StatusMark, PriorityGlyph (not at Medium), \`.card-id\` (mono, tabular), \`.card-board\` (the workstream, only when the view isn't already grouped by it) and \`.card-date\` (relative time: \`5h\`, \`2d\`, \`now\`).
- \`.card-title\`: the display face at 14px, \`--leading-card\` (1.32), clamped to two lines.
- \`.card-foot\`: the epic tag, labels (\`.tag.neutral\`), plugin badges and custom fields (\`.card-field\`, "Name · value").

States: hover raises it (\`elev-raised\`); \`data-selected="true"\` rings it in \`accent\`; \`.dragging\` fades it to 55%. Focus shows \`focus-ring\`.

Keyboard twin for every board write: \`Enter\`/\`Space\` open it, \`⌥←\`/\`⌥→\` move it one column through the same write path as a drag; arrows move focus between cards.

The consumer provides the item (key, title, status, priority, labels, epic name and hue, updated time, provenance) and the fields chosen for the view.
`,
  preview: doc(`<!-- @dsCard group="Board" height=330 subtitle="default · agent write · selected · locked · done" -->`, `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,330px));gap:8px">
${card({ key: "TOM-18", title: "Command palette over boards, views, issues and actions", status: "s-backlog", ws: ["i-panel", "UI"], tags: [["ui"]] })}
${card({ key: "TOM-8", title: "Auto-create a default view for existing boards", prio: "p-3", ws: ["i-stack", "Core &amp; data"], date: "5h", epic: "Multi-board architecture", hue: 150, tags: [["migration"], ["blocked", ""]] })}
${card({ key: "TOM-19", title: "Inline column composer; retire the New Ticket modal", status: "s-doing", ws: ["i-panel", "UI"], prov: "ai", tags: [["ui"]] })}
${card({ key: "TOM-9", title: "Add matcha to ThemePreference and the four-segment switcher", status: "s-todo", ws: ["i-panel", "UI"], date: "6h", selected: true, epic: "Theme token refactor", hue: 300, tags: [["ui"]] })}
${card({ key: "TOM-10", title: "Conflict banner is dark-only and unreadable in light mode", status: "s-verifying", prio: "p-4", ws: ["i-panel", "UI"], date: "2m", prov: "lock", tags: [["bug"], ["blocked", ""]] })}
${card({ key: "TOM-4", title: "Shape-coded status marks", status: "s-done", done: true, prio: "p-1", date: "3d" })}
</div>`),
};

C.Column = {
  group: "Board", height: 330, subtitle: "head · count · WIP over · empty",
  readme: `# Column

One column of the board: \`.col\` (330px) with \`.col-head\` and \`.col-body\`.

- \`.col-head\`: \`.col-num\` (the column's position, two digits in \`accent\`), \`.col-name\`, \`.col-count\` (mono, tabular; \`.over\` in \`warn\` when a WIP cap is passed). A hairline \`border\` under it.
- \`.col-body\`: cards with an 8px gap; it scrolls on its own. \`.col.drop-target\` washes it in \`surface-warm\` with a dashed outline while a card is dragged over.
- \`.col-empty\`: a sentence in \`meta\` when nothing matches.

Columns sit in \`.col-track\` (16px gaps and padding, horizontal scroll); when more columns lie to the right, \`.board-scroll-hint\` ("Scroll right to see more columns") floats at the bottom.

The consumer provides the column's value (a status, a priority, a workstream: whatever the view columns by), its cards and an optional cap.
`,
  preview: doc(`<!-- @dsCard group="Board" height=330 subtitle="head · count · WIP over · empty" -->`, `<div style="display:flex;gap:16px">
<div class="col" role="group" aria-label="Backlog, 2"><div class="col-head"><span class="col-num">01</span><span class="col-name">Backlog</span><span class="col-count num">2</span></div><div class="col-body">
${card({ key: "TOM-18", title: "Command palette over boards, views, issues and actions", status: "s-backlog", tags: [["ui"]] })}
${card({ key: "TOM-20", title: "items.priority column and the five-level glyph", status: "s-backlog", prio: "p-1", date: "3d", prov: "ai", epic: "Multi-board architecture", hue: 150, tags: [["core"]] })}
</div></div>
<div class="col" role="group" aria-label="Doing, 4 of 3"><div class="col-head"><span class="col-num">03</span><span class="col-name">Doing</span><span class="col-count num over">4 / 3</span></div><div class="col-body">
${card({ key: "TOM-19", title: "Inline column composer; retire the New Ticket modal", status: "s-doing", prov: "ai", tags: [["ui"]] })}
</div></div>
<div class="col" role="group" aria-label="Verifying, 0"><div class="col-head"><span class="col-num">04</span><span class="col-name">Verifying</span><span class="col-count num">0</span></div><div class="col-body"><p class="col-empty">Nothing here yet. Drag a card in, or press ⌥→ on a focused card.</p></div></div>
</div>`),
};

C.Menu = {
  group: "Overlays", height: 300, subtitle: "radio rows · counts · foot link",
  readme: `# Menu

A dropdown: \`.menu\` (\`surface\`, \`border\`, \`--radius-md\`, \`elev-raised\`, 236px min, scrolls past 324px). Under Radix it carries \`.is-floating\` and positions statically inside the portal.

- \`.menu-head\`: an eyebrow title and an aside.
- \`.menu-row\`: \`.m-mark\` (icon or \`.menu-row__check\`), \`.m-name\`, optional \`.m-sub\` under it (in \`.m-stack\`), \`.m-count\`. \`aria-checked="true"\` for the current choice; \`.is-radio\` makes the check round. Highlight is \`surface-warm\`.
- \`.menu-foot\`: a hairline, then link rows (\`.m-link\`).
- \`.menu.wide\` is 300px; \`.menu.right\` aligns to the trigger's right edge.

Used for the project switcher, the view switcher, query-bar choices and settings selects.
`,
  preview: doc(`<!-- @dsCard group="Overlays" height=300 subtitle="radio rows · counts · foot link" -->`, `<div class="menu wide is-floating" role="menu" style="max-width:340px">
  <div class="menu-head"><span class="eyebrow">Projects</span><span class="meta-txt" style="margin-left:auto">This machine</span></div>
  <button class="menu-row is-radio" role="menuitemradio" aria-checked="true"><span class="menu-row__check">${I("i-check", 10)}</span><span class="m-mark">${I("i-stack", 13)}</span><span class="m-stack"><span class="m-name">Tomrade</span><span class="m-sub">14 views · 22 open</span></span></button>
  <button class="menu-row is-radio" role="menuitemradio" aria-checked="false"><span class="menu-row__check"></span><span class="m-mark">${I("i-stack", 13)}</span><span class="m-stack"><span class="m-name">Muduo</span><span class="m-sub">Local project</span></span></button>
  <button class="menu-row is-radio" role="menuitemradio" aria-checked="false" data-highlighted=""><span class="menu-row__check"></span><span class="m-mark">${I("i-archive", 13)}</span><span class="m-stack"><span class="m-name">Tomrade Legacy</span><span class="m-sub">Archived</span></span></button>
  <div class="menu-foot"><button class="menu-row m-link">${I("i-home", 13)}<span class="m-name">All projects</span></button></div>
</div>`),
};

C.Dialog = {
  group: "Overlays", height: 330, subtitle: "head · body · foot · danger confirm",
  readme: `# Dialog

A modal sheet: \`.palette.modal\` over a \`.scrim\` (\`fg\` at 42%), centred on the workspace row (\`--overlay-mid\`), not the window. Parts: \`.dlg-head\` (title and a close \`btn-icon\`), \`.dlg-body\` (scrolls), \`.dlg-foot\` (actions, right-aligned). Sizes: 620px default, \`.wide\` 760px, \`.sheet-settings\` 964px with a \`.dlg-nav\` rail.

Radix owns the focus trap, the inert background and focus restore. \`Esc\` closes the innermost layer first; on a delete confirmation it cancels, never confirms.

**Two irreversible writes, and each asks in the words it will be judged by.** Purging an issue is one click on a sheet that names the version it was rendered from; deleting a project asks for its name. The confirm is the dialog's one \`btn-danger\`; Cancel takes focus.
`,
  preview: doc(`<!-- @dsCard group="Overlays" height=330 subtitle="head · body · foot · danger confirm" -->`, `<div class="palette modal" role="dialog" aria-label="Delete TOM-18" style="position:relative;top:auto;left:auto;transform:none;width:min(560px,100%);max-height:none">
  <div class="dlg-head"><h2 class="dlg-title" style="font-size:var(--text-lg)">Delete TOM-18 permanently?</h2><span class="spacer" style="flex:1"></span><button class="btn btn-icon" aria-label="Close">${I("i-close")}</button></div>
  <div class="dlg-body" style="display:flex;flex-direction:column;gap:12px">
    <div class="dangerbar">${I("i-warn", 14, "b-mark")}<div><p style="color:var(--fg)">This can't be undone. ⌘Z will not bring it back.</p><ul class="del-list"><li>“Command palette over boards, views, issues and actions”, as of version 7</li><li>Its 2 labels and 1 dependency</li></ul></div></div>
  </div>
  <div class="dlg-foot"><button class="btn btn-secondary">Cancel</button><button class="btn btn-danger">Delete permanently</button></div>
</div>`),
};

C.CommandPalette = {
  group: "Overlays", height: 360, subtitle: "input · groups · rows · foot",
  readme: `# CommandPalette

\`⌘K\`: the primary navigation. One palette spanning every view, every issue, every file and every action; the sidebar is for orientation, the palette is for speed.

Parts: \`.palette\` (560px, \`--radius-lg\`, \`elev-raised\`, 96px from the top over a \`.scrim\`) › \`.palette-input\` (\`--text-md\`) › \`.palette-list\` › \`.eyebrow.palette-group\` headings › \`.palette-row\` (\`.palette-mark\`, \`.p-label\`, a \`.card-id\` or \`.kbd\` at the end; \`data-selected="true"\` on the active row) › \`.palette-foot\` (key hints in \`meta\`).

Plugin commands appear as rows from data, never from plugin React code.
`,
  preview: doc(`<!-- @dsCard group="Overlays" height=360 subtitle="input · groups · rows · foot" -->`, `<div class="palette" role="dialog" aria-label="Command palette" style="position:relative;top:auto;left:auto;transform:none;width:min(560px,100%);max-height:none">
  <input class="palette-input" id="pal" value="theme" aria-label="Search">
  <div class="palette-list">
    <p class="eyebrow palette-group">Tickets</p>
    <button class="palette-row" data-selected="true"><span class="palette-mark">${I("s-todo", 12, "sdot")}</span><span class="p-label">Add matcha to ThemePreference and the four-segment switcher</span><span class="card-id">TOM-9</span></button>
    <button class="palette-row"><span class="palette-mark">${I("s-verifying", 12, "sdot")}</span><span class="p-label">Conflict banner is dark-only and unreadable in light mode</span><span class="card-id">TOM-10</span></button>
    <p class="eyebrow palette-group">Actions</p>
    <button class="palette-row"><span class="palette-mark">${I("i-sun")}</span><span class="p-label">Switch theme…</span></button>
    <button class="palette-row"><span class="palette-mark">${I("i-gear")}</span><span class="p-label">Open settings</span><span class="kbd">⌘,</span></button>
  </div>
  <div class="palette-foot">↑↓ to move · ↵ to open · Esc to close</div>
</div>`),
};

C.Toast = {
  group: "Overlays", height: 150, subtitle: "info with Undo · error",
  readme: `# Toast

A short report of what just happened, bottom-left above the status bar. \`.toast\`: \`.ribbon-tick\` (2px \`accent\`), \`.toast-body\`, an optional ghost action (Undo) and a close \`btn-icon\`. \`.is-error\` edges it in \`danger\`.

The stack is \`role="status" aria-live="polite"\`; the 6s countdown holds while a toast is hovered or focused, because an Undo that expires mid-reach is not an affordance.

Copy says what happened in the past tense, with the thing's name: "Reverted TOM-18", "Moved TOM-9 to Doing". A refused move says why: "TOM-9 is already in the last column".
`,
  preview: doc(`<!-- @dsCard group="Overlays" height=150 subtitle="info with Undo · error" -->`, col(
    `<div class="toast"><span class="ribbon-tick"></span><span class="toast-body" style="flex:1;line-height:var(--leading-dense)">Moved TOM-9 to Doing</span><button class="btn btn-ghost">Undo</button><button class="btn btn-icon" aria-label="Dismiss">${I("i-close", 12)}</button></div>` +
    `<div class="toast is-error"><span class="ribbon-tick"></span><span class="toast-body" style="flex:1;line-height:var(--leading-dense)">Couldn't save TOM-18: an agent changed it while you were editing. Your text is kept.</span><button class="btn btn-icon" aria-label="Dismiss">${I("i-close", 12)}</button></div>`, 10)),
};

C.Banner = {
  group: "Overlays", height: 110, subtitle: "warning with action",
  readme: `# Banner

A standing notice inside a pane, above what it concerns: \`.banner\` (\`surface\`, a 1px \`warn\` edge, \`--text-sm\`), \`.b-mark\` (\`i-warn\` in \`warn\`), the sentence, then a secondary action and a ghost Dismiss. It wraps under 22ch.

Say what is wrong and what fixes it, naming the thing: "The workstream “UI” has no local repository on this machine (tomrade), so its tickets can't start here."
`,
  preview: doc(`<!-- @dsCard group="Overlays" height=110 subtitle="warning with action" -->`, `<div class="banner" role="note" style="margin:0">${I("i-warn", 15, "b-mark")}<span>The workstream “UI” has no local repository on this machine (tomrade), so its tickets can't start here.</span><button class="btn btn-secondary">Set local repository…</button><button class="btn btn-ghost">Dismiss</button></div>`),
};

C.TitleBar = {
  group: "Chrome", height: 110, subtitle: "home · project switcher · crumb · actions",
  readme: `# TitleBar

The 42px (\`--titlebar-h\`) top bar, \`surface\` with a \`border\` hairline under it. **Leaving a project is titlebar chrome**: Home (\`i-home\`) *leaves* the project, the switcher (\`#projSwitch\`: \`i-stack\`, name, chevron) *rebinds* it; two jobs, two controls, separated by a hairline (\`.title-sep\`), not a slash. Then \`/\` and the current view or file (\`.crumb-title\`).

Right side, in order: Search with \`⌘K\`, the one primary **New**, Auto run, Terminal window, Usage (\`i-bars\`), Settings (\`i-gear\`). Labels drop at container widths (960 / 830 / 775 / 700px). On macOS the left gutter grows to 86px (\`--traffic-inset\`) for the window controls.
`,
  preview: doc(`<!-- @dsCard group="Chrome" height=110 subtitle="home · project switcher · crumb · actions" -->`, `<header class="titlebar" style="height:var(--titlebar-h);border:1px solid var(--border)">
  <button class="btn btn-icon no-drag" aria-label="All projects">${I("i-home", 16)}</button>
  <span class="title-sep"></span>
  <button class="btn btn-ghost" id="projSwitch" style="padding:4px 8px">${I("i-stack", 15, "ico")}<span>Tomrade</span>${I("i-chevdown", 13, "chev")}</button>
  <span class="crumb-sep">/</span><span class="crumb-title">Backlog</span>
  <span class="spacer" style="flex:1"></span>
  <button class="btn btn-ghost">${I("i-search")}<span>Search</span><span class="kbd">⌘K</span></button>
  <button class="btn btn-primary">${I("i-plus")}New</button>
  <button class="btn btn-ghost titlebar-night-shift">${I("i-moon", 15)}<span class="lbl">Auto run</span></button>
  <button class="btn btn-ghost titlebar-terminal">${I("i-terminal", 15)}<span class="lbl">Terminal window</span></button>
  <button class="btn btn-icon" aria-label="Usage">${I("i-bars", 17)}</button>
  <button class="btn btn-icon" aria-label="Settings">${I("i-gear", 17)}</button>
</header>`, "padding:0"),
};

C.Sidebar = {
  group: "Chrome", height: 720, subtitle: "modules · views · workstreams · project settings",
  readme: `# Sidebar

The project's modules, one door each: **Files**, **Routines**, **Backlog** (saved views and workstreams) and any a plugin contributes; nothing else. It answers "which view", never "which container". 264px (\`--sidebar-w\`, resizable), \`bg\` ground, a \`border\` hairline on the right. Inside, the type scale steps up one notch (\`--text-xs\` 13, \`--text-sm\` 14, \`--text-base\` 16).

- \`.side-module\`: a fold chevron (its room kept when there are no rows), the title in small caps-like \`--text-sm\` 600 with 1px tracking, drag the head to reorder. One gap and a 0.5px rule between modules.
- \`.side-sub-label\`: "Views", "Workstreams" in \`meta\`.
- \`.side-row\`: icon, \`.side-name\`, \`.side-count\` (mono). Current row: \`surface-warm\` fill, a 2px \`accent\` left border, the icon in \`accent\`; its count steps up to \`muted\` (4.5:1).
- \`.side-row.is-workstream\`: a second line naming the repository (\`.side-ws-repo\`; italic when none).
- \`.side-settings\`: Project settings at the foot.

\`⌘B\` folds it to the 48px rail, remembered per machine.
`,
  preview: doc(`<!-- @dsCard group="Chrome" height=720 subtitle="modules · views · workstreams · project settings" -->`, `<aside class="sidebar" style="height:700px">
  <div class="side-head"><span class="spacer" style="flex:1"></span><button class="btn btn-icon" aria-label="Collapse sidebar">${I("i-panel", 15)}</button></div>
  <div class="side-scroll">
    <section class="side-group side-module"><div class="side-label-row side-module-head"><button class="btn btn-icon side-module-fold" aria-label="Fold">${I("i-chevdown", 12)}</button><span class="side-label side-module-title"><span class="side-label-btn side-module-btn">${I("i-folder", 15)}<span class="side-module-title">FILES</span></span></span></div>
      <div class="side-module-body"><p class="side-module-empty">Drag files here</p></div></section>
    <section class="side-group side-module"><div class="side-label-row side-module-head"><span class="side-module-fold-space"></span><span class="side-label-btn side-module-btn">${I("i-alarm", 15)}<span class="side-module-title">ROUTINES</span></span></div></section>
    <section class="side-group side-module"><div class="side-label-row side-module-head"><button class="btn btn-icon side-module-fold" aria-label="Fold">${I("i-chevdown", 12)}</button><span class="side-label-btn side-module-btn" aria-current="true">${I("i-board", 15)}<span class="side-module-title">BACKLOG</span></span></div>
      <div class="side-module-body"><div class="side-sub side-views"><div class="side-sub-label">Views</div><div class="side-list" style="display:flex;flex-direction:column;gap:1px">
        <button class="side-row is-view" aria-current="true">${I("i-board", 15, "ico")}<span class="side-name">Backlog</span><span class="side-count num">21</span></button>
        <button class="side-row is-view">${I("i-clock", 15, "ico")}<span class="side-name">Recently updated</span><span class="side-count num">21</span></button>
        <button class="side-row is-view">${I("i-stack", 15, "ico")}<span class="side-name">By epic</span><span class="side-count num">21</span></button>
        <button class="side-row is-view">${I("i-bug", 15, "ico")}<span class="side-name">Bugs</span><span class="side-count num">3</span></button>
        <button class="side-row is-view">${I("i-pen", 15, "ico")}<span class="side-name">Agent writes</span><span class="side-count num">4</span></button>
        <button class="side-row side-add side-new-view">${I("i-plus", 14, "ico")}<span class="side-name">New view</span></button>
      </div></div>
      <div class="side-sub side-workstreams"><div class="side-sub-label">Workstreams</div><div class="side-list" style="display:flex;flex-direction:column;gap:1px">
        <div class="side-ws-container"><button class="side-row is-workstream">${I("i-panel", 15, "ico")}<span class="side-ws-text"><span class="side-name">UI</span><span class="side-ws-repo num">${I("i-branch", 11)}<span class="side-ws-repo-name">tomrade</span></span></span><span class="side-count num">12</span></button></div>
        <div class="side-ws-container"><button class="side-row is-workstream">${I("i-plug", 15, "ico")}<span class="side-ws-text"><span class="side-name">MCP server</span><span class="side-ws-repo num is-none"><span class="side-ws-repo-name">No repository</span></span></span><span class="side-count num">4</span></button></div>
      </div></div></div></section>
  </div>
  <div class="side-settings"><button class="side-row side-project-settings">${I("i-gear", 15, "ico")}<span class="side-name">Project settings</span></button></div>
</aside>`, "padding:0"),
};

C.TabStrip = {
  group: "Chrome", height: 90, subtitle: "selected · open · pinned backlog",
  readme: `# TabStrip

The 36px strip above the board and files: what is open, \`.tab\` per view or file. The selected tab joins the pane below (\`bg\` fill, \`border\` sides, a 2px \`accent\` cap) and its icon turns \`accent\`; others are \`muted\` on a \`surface-warm\`/\`bg\` mix. \`.tab-close\` shows on hover and on the selected tab. The backlog tab (\`.is-backlog\`) has no close.
`,
  preview: doc(`<!-- @dsCard group="Chrome" height=90 subtitle="selected · open · pinned backlog" -->`, `<div class="tab-strip" role="tablist" style="max-width:640px">
  <div class="tab is-backlog" role="tab" aria-selected="true">${I("i-board", 13, "tab-ico")}<span class="tab-name">Backlog</span></div>
  <div class="tab" role="tab" aria-selected="false">${I("i-file", 13, "tab-ico")}<span class="tab-name">design-system.md</span><button class="tab-close" aria-label="Close tab">${I("i-close", 10)}</button></div>
  <div class="tab" role="tab" aria-selected="false">${I("i-graph", 13, "tab-ico")}<span class="tab-name">Dependencies</span><button class="tab-close" aria-label="Close tab">${I("i-close", 10)}</button></div>
</div>`),
};

C.StatusBar = {
  group: "Chrome", height: 90, subtitle: "MCP · last write · undo · history · troubleshoot",
  readme: `# StatusBar

The 29px (\`--statusbar-h\`) foot: \`surface\`, a \`border\` hairline on top, \`--text-xs\` in \`meta\`. Left: the MCP server's live dot and port (\`.live-dot\` in \`success\`, the address in \`.num\`), the last write as a ribbon (\`.ribbon-tick\`, "You created view · now"), the repository, Undo, Redo and History as ghost buttons. Right: Troubleshoot and Feedback as dotted-underline \`.status-link\`s. Plugins add \`.status-item\`s from data.
`,
  preview: doc(`<!-- @dsCard group="Chrome" height=90 subtitle="MCP · last write · undo · history · troubleshoot" -->`, `<footer class="statusbar" style="height:var(--statusbar-h);border:1px solid var(--border)">
  <span class="status-item"><span class="live-dot"></span>MCP <span class="num">127.0.0.1:55723</span></span>
  <span class="status-item status-ribbon"><span class="ribbon-tick"></span><span class="status-clip">You moved TOM-9 · now</span></span>
  <span class="status-item">tomrade</span>
  <button class="btn btn-ghost status-undo" style="padding:2px 7px;font-size:var(--text-xs)">${I("i-undo", 12)}Undo</button>
  <button class="btn btn-ghost status-redo" style="padding:2px 7px;font-size:var(--text-xs)">${I("i-redo", 12)}Redo</button>
  <button class="btn btn-ghost status-history" style="padding:2px 7px;font-size:var(--text-xs)">${I("i-history", 12)}History</button>
  <span class="spacer" style="flex:1"></span>
  <button class="status-item status-link">${I("i-bug", 12)}Troubleshoot</button>
  <button class="status-item status-link">${I("i-send", 12)}Feedback</button>
</footer>`, "padding:0"),
};

C.DetailPane = {
  group: "Chrome", height: 560, subtitle: "head · title · field rows · body",
  readme: `# DetailPane

A ticket opened beside the board: \`aside.detail\`, 440px (\`--detail-w\`), \`bg\` ground, a \`border\` hairline on the left. \`⌘⇧↵\` or the expand button lifts it into \`.detail.expanded\`, an 880px dialog with a field strip and a side rail.

- \`.detail-head\`: the key (\`.card-id\`), the workstream tag, then Start (the pane's one primary), Lock, Delete (\`btn-icon.is-danger\`), Expand, Close.
- \`.detail-title\`: \`--text-xl\` in the display face; click to edit.
- \`.field-row\`: a 92px uppercase \`dt\` in \`meta\` and the value; a \`border-soft\` rule above each. Every attribute is a field: work type, status, priority, epic, labels, blocked by, blocks, workstream, custom fields, last change.
- \`.issue-body\`: the description, Markdown that reads as text (66ch). A click opens the source; \`⌘↵\` saves, \`Esc\` discards.

The consumer provides the item, its fields and relations.
`,
  preview: doc(`<!-- @dsCard group="Chrome" height=560 subtitle="head · title · field rows · body" -->`, `<aside class="detail" tabindex="-1" style="height:540px;border:1px solid var(--border)">
  <div class="detail-head"><span class="card-id">TOM-18</span><span class="tag neutral">UI</span><span class="spacer" style="flex:1"></span><button class="btn btn-primary">Start</button><button class="btn btn-ghost">${I("i-lock", 13)}Lock</button><button class="btn btn-icon is-danger" aria-label="Delete">${I("i-trash")}</button><button class="btn btn-icon" aria-label="Expand">${I("i-expand")}</button><button class="btn btn-icon" aria-label="Close">${I("i-close")}</button></div>
  <div class="detail-body">
    <h2 class="detail-title">Command palette over boards, views, issues and actions</h2>
    <dl class="fieldstrip" style="margin-bottom:0">
      <div class="field-row"><dt>Work type</dt><dd>Coding</dd></div>
      <div class="field-row"><dt>Status</dt><dd>${I("s-backlog", 12, "sdot")}Backlog</dd></div>
      <div class="field-row"><dt>Priority</dt><dd>${I("p-2", 12, "prio")}Medium</dd></div>
      <div class="field-row"><dt>Labels</dt><dd><span class="tag">ui</span><button class="btn btn-ghost" style="padding:1px 6px;font-size:var(--text-xs)">+ Label</button></dd></div>
      <div class="field-row"><dt>Workstream</dt><dd>UI</dd></div>
      <div class="field-row"><dt>Last change</dt><dd>Human · 2d ago</dd></div>
    </dl>
    <div class="issue-body"><p>One palette spanning every board-view pair, every issue and every action. This becomes the primary navigation: the sidebar is for orientation, the palette is for speed.</p></div>
  </div>
</aside>`),
};

C.Icon = {
  group: "Foundations", height: 300, subtitle: "the 74-symbol sprite",
  readme: `# Icon

The icon sprite, verbatim from \`packages/ui/src/components/icons.tsx\`: inline SVG only, never emoji. Every symbol is drawn on a 14×14 viewBox with a 1.2px round stroke in \`currentColor\`, so it takes the colour of its text.

Use: \`<svg width="14" height="14"><use href="components/icons.svg#i-plus"/></svg>\` (in the app: \`<Icon name="i-plus" size={14} />\`). Sizes in use: 11 (card meta), 12–13 (menus, query bar), 14 (default), 15 (sidebar rows, titlebar), 16–17 (titlebar icon buttons).

Names: \`i-*\` are UI icons; \`s-*\` are the six status marks and \`p-*\` the five priority glyphs (see Marks). \`s-done\` and \`p-4\` cut their inner mark in \`var(--surface)\`.
`,
  preview: null, // generated below from icons.json
};

// the icon gallery reads the sprite live
const syms = JSON.parse(fs.readFileSync(path.join(out, "icons.json"), "utf8"));
C.Icon.preview = doc(`<!-- @dsCard group="Foundations" height=300 subtitle="the 74-symbol sprite" -->`, `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:4px;color:var(--fg-2)">
${syms.map((s) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px;border-radius:var(--radius-sm)">${I(s.id, 20)}<span class="card-id" style="font-size:11px">${s.id}</span></div>`).join("\n")}
</div>`);

for (const [name, c] of Object.entries(C)) {
  const dir = path.join(out, "project/components", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), c.readme);
  fs.writeFileSync(path.join(dir, "preview.html"), c.preview);
}
console.log(Object.keys(C).length, "components");
