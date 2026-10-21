# Tomrade — Design

Living design spec for the prototype screens in this folder. Last verified against the
build on 2026-08-26.

## 0. What this file is

Three documents govern the design, and they do not overlap:

| Document | Scope | Where |
|---|---|---|
| **kami `DESIGN.md`** | The design *system* — parchment canvas, ink-blue accent, serif hierarchy, elevation, tag tints. Generic, says nothing about Tomrade. | OpenDesign app bundle, `design-systems/kami/` |
| **`prototype-plan.md`** | The redesign *plan* — concept, IA, the full token table (§7), the component-state matrix (§10), acceptance checks (§12). Written before the build. | OD project folder |
| **This file** | What the build actually does, and the rules that are easy to violate on the next edit. | here |

Read the plan for the token table and the state matrix — they are correct and this file
does not restate them. Read this for the deltas, the invariants, and the divergences.

The screens themselves are the final authority. Where this file and the HTML disagree,
the HTML is right and this file is stale — fix it.

## 1. Screens

| File | Role |
|---|---|
| `index.html` | Launcher / overview |
| `projects-home.html` | Project list — the home screen |
| `workspace-board.html` | The board. The main screen; everything else is reachable from it |
| `issue-detail.html` | Issue detail, standalone |
| `board-settings.html` | Board settings, standalone |
| `settings-themes.html` | Appearance, tokens, assistant, agent access, data |

`workspace-board.html` also carries in-page copies of the projects screen and the settings
screen. See §6 — that is a prototype constraint, not a product decision.

## 2. Design-system binding, and where it departs from kami

Light mode uses kami's declared hexes verbatim. Dark and matcha are derived with `oklch()`
and contrast-solved, not eyeballed. The full three-column table is plan §7.

Four departures from kami are deliberate and load-bearing:

**The type scale is rebound for UI density.** kami's scale is print-rooted (11px captions,
14px body, 32px section titles). A tracker at desktop width needs more. The build runs:

```
--text-xs 12  --text-sm 13  --text-base 15  --text-md 17
--text-lg 19  --text-xl 24  --text-2xl 35
```

Roughly kami × 1.09, applied uniformly so the ratios survive. This is not recorded in the
plan — it was settled during the build. Do not "restore" kami's values.

**Matcha is a dark theme.** Steeped-tea ground, matcha-powder accent. Paper is the only
light mode; Ink and Matcha are both dark. The accent is *replaced*, never added to — the
single-accent rule holds in all three themes.

**Hover lightens on the dark themes.** kami expresses hover through elevation and keeps the
accent colour stable. That works on parchment; on a dark ground it makes hover invisible.
`--accent-active` therefore moves *up* in L on `.dark` and `.matcha` so contrast rises on
state change, never falls.

**`--font-mono` drops kami's CJK fallback.** The mono stack here only ever sets Latin
identifiers — issue IDs, package paths, endpoints, token names. Add the CJK tail back if
the product ever renders CJK in mono.

Two project-specific token groups have no kami equivalent:

- **App-chrome geometry** — `--titlebar-h`, `--statusbar-h`, `--sidebar-w`, `--detail-w`,
  `--traffic-inset`. Electron shell measurements, not design-system values.
- **`--leading-card: 1.32`** — below kami's 1.40 floor. A documented exception; card titles
  are two-line fragments, not reading copy. Plan §7 covers the reasoning.

`--traffic-inset` is a **gutter**, not a traffic-light reservation. It was 80px, which read
as a hole in the top-left. The shell overlays its own window controls, so the bar owns the
same 12px gutter the sidebar and the right edge use.

## 3. Invariants

These are the rules that get broken first, because nothing in the code stops you.

**The sidebar answers "which workstream". The board space answers "which slice of it".**
A view is a slice of one board, not a place you navigate to — views are tabs over the board,
never nodes in the sidebar tree. One tab strip, one grouping switch, no rival controls.

**Leaving a project is titlebar chrome.** The sidebar holds boards and cross-board scopes
and nothing else. Home and the project switcher live in the titlebar, side by side — two
controls because they are two different jobs: home *leaves* the project, the switcher
*rebinds* it in place.

**One solid button per viewport, per action.** Hover on a solid button swaps foreground and
background in the same rule. Everything else is ghost, secondary, or a text link.

**Status and priority are shape-coded, not colour-coded.** Five priority levels and six
statuses, each distinguishable in greyscale. Colour is confirmation, never the signal.

**Provenance is a margin mark.** Agent writes get a tick, human-locked fields get a glyph,
human writes get nothing. It sits in the gutter and never becomes a badge.

**Every board write needs a keyboard twin.** Dragging is a mouse affordance. If a mutation
is reachable only by pointer, it is unfinished — see §4.

**Numbers that stack get `tabular-nums`.** Column counts, WIP caps, issue IDs, metric rows.
Not prose.

## 4. Interaction and keyboard

Implemented, verified against the build:

| Key | Action |
|---|---|
| `⌘K` | Command palette — the primary navigation |
| `⌘N` | New issue |
| `⌘P` | Project switcher dropdown |
| `⌘J` | Toggle AI panel |
| `⌘,` | Settings |
| `⌘Z` | Undo last write |
| `Enter` / `Space` | Open the focused card |
| `←` / `→` | Move the focused card one column, through the same write path as a drag |
| `Esc` | Close, innermost first — projects screen → project menu → board menu → filter menu → dialog → detail pane |

`←`/`→` keeps focus on the card across the re-render, and refuses past either end with a
toast rather than failing silently. Discoverable via the card tooltip and `aria-keyshortcuts`.

Card focus moves by `Tab`. Arrow-key focus traversal across columns is specified in the plan
but not built — see §7.

## 5. Accessibility floor

Target is **WCAG 2.2 AA**. Verified in the 2026-08-26 pass:

- **Text contrast** — every foreground token clears 4.5:1 on every surface it lands on.
  `--meta` on `--surface-warm` resolves to 4.34:1, so small labels on hovered and current
  rows step up to `--muted` (6.6:1). Check this pairing whenever you add a label to a warm
  surface.
- **Focus** — global `:focus-visible` ring at `--focus-ring`. Dialogs trap `Tab` and restore
  focus to whatever opened them.
- **Live regions** — the toast stack is `role="status" aria-live="polite"`. The AI transcript
  is `role="log"` with `aria-busy` during a pending turn.
- **Toast timing** — the 6s countdown holds while a toast is hovered or holds focus. An Undo
  button that expires mid-reach is not an affordance.
- **Reduced motion** — `prefers-reduced-motion: reduce` strips all transitions, including an
  explicit unwind of the theme crossfade's `!important`. Nothing in the build loops or
  autoplays, so there is nothing else to pause.
- **Names** — board columns are `role="group"` with a live count in the label. Icon-only
  controls carry `aria-label`.

Known gap: chrome icon buttons are ~28px. That clears the 2.5.8 AA floor (24×24) but is under
the 2.5.5 enhanced target (44×44). Acceptable for a desktop shell; revisit for tablet.

## 6. Prototype-only constraints

**Cross-screen links.** OpenDesign renders each file in a `srcdoc` frame, where a relative
`href` has no base URL to resolve against — a file-to-file jump silently dies. So
`workspace-board.html` mounts the projects screen and the settings screen **in-page**: the
projects screen as a full route over the workspace, settings as a modal. Both carry a
"Standalone screen ↗" link out to the real file.

This is a rendering-host workaround, **not** a product decision. In the real app these are
routes. Opened from the filesystem the `href`s resolve normally and the file links work.

**No async.** All data is in-page. The assistant's pending state is a 700ms timer, and the
conflict banner is armed to fire on a scripted first move. Neither is a network call.

## 7. Divergences from `prototype-plan.md`

The build and the plan disagree in three places. The build is shipped; the plan is not
wrong so much as unreconciled. Pick one before implementation.

| Plan §3 | Build | Note |
|---|---|---|
| `⌘⇧←/→` moves the focused card | plain `←`/`→` | Plain arrows are cheaper to reach and collide with nothing — a card is not a text field. But `⌘⇧` leaves arrows free for focus traversal, which the plan also wants. **These two are in tension; resolve together.** |
| `↑↓←→` moves card *focus* across columns | not built; `Tab` only | Blocked on the row above |
| `N` opens the inline composer in the focused column | not built | Each column has a persistent "New issue" button instead |

`⌘,` for settings is in the build and not in the plan. Harmless; add it to the plan.
