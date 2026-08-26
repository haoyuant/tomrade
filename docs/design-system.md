# Design system — "The Ledger"

Derived from the OpenDesign prototype in `design/`. That folder is the visual
authority; this file says where each part of it now lives in code, and which
rules nothing in the compiler will stop you breaking.

Where `design/DESIGN.md` and the prototype HTML disagree, the HTML wins. Where
two prototype files disagree, `design/workspace-board.html` wins — see
[Divergences](#divergences).

## Where it lives

| Layer | File |
|---|---|
| Tokens, base, every component class | `packages/ui/src/styles/app.css` |
| Tailwind + shadcn token aliases | same file, the two `@theme` blocks |
| Icon sprite (41 symbols, inline SVG) | `packages/ui/src/components/icons.tsx` |
| Domain vocabulary: statuses, priorities, grouping, the live query | `packages/ui/src/lib/domain.ts` |
| Primitives on Radix, styled by the design's classes | `packages/ui/src/components/ui/` |
| Theme resolution and the crossfade | `packages/ui/src/lib/theme.tsx` |
| Toasts, including the hold-on-hover countdown | `packages/ui/src/lib/toast.tsx` |

## Tokens

Three themes, one declaration set. `:root` is Paper; `.dark` (Ink) and
`.matcha` override only the 24 colour tokens that vary. Everything else —
type scale, leading, tracking, radii, spacing, chrome geometry — is declared
once and never re-declared per theme.

Theme-invariant scales live inside Tailwind's `@theme` block, so one
declaration serves both the component CSS (`var(--text-sm)`) and the utilities
(`text-sm`). Colours and shadows are mapped through `@theme inline`, which
makes `bg-surface` emit `var(--surface)` directly — a class swap on `<html>`
therefore reaches the utilities with no rebuild.

shadcn's names are aliased onto ours in the same block. Two are traps:

- kami's `--muted` is a **text** colour; shadcn's is a background. Ours is
  exposed as `text-muted-fg`, and shadcn's `--muted` is left alone.
- kami's `--accent` is the brand colour; shadcn's `--accent` is a neutral hover
  fill. So shadcn's `--accent` maps to `--surface-warm`, and kami's accent
  reaches shadcn only through `--primary`.

## Invariants

These are the rules that get broken first, because nothing in the code stops you.

**A board owns its issues; a view slices one board.** The sidebar answers
"which workstream", the board space answers "which slice of it". `items.board_id`
is the ownership; a view is a stored `(groupBy, columns, filter, wip)`. Dragging
writes the grouped field and **never** `board_id` — moving a workstream is a
deliberate act, which is why it lives in board settings as a bulk move.

**Leaving a project is titlebar chrome.** The sidebar holds boards and
cross-board scopes and nothing else. Home *leaves* the project, the switcher
*rebinds* it — two jobs, two controls, separated by a hairline not a slash.

**One solid button per viewport, per action.** Hover on a solid button swaps
foreground and background in the same rule. Everything else is ghost,
secondary, or a text link.

**Status and priority are shape-coded, not colour-coded.** Six statuses and
five priorities, each distinguishable in greyscale. Colour is confirmation,
never the signal. The priority glyph is suppressed at its default (Medium, 2)
so its presence always means something.

**Provenance is a margin mark.** Agent writes get a tick in the card gutter,
human-locked fields a glyph, human writes nothing. It never becomes a badge.
Provenance is derived from `updatedBy` + `humanLocked` and is never stored.

**Every board write needs a keyboard twin.** `←`/`→` moves the focused card one
column through the same write path as a drag, keeps focus across the re-render,
and refuses past either end with a toast rather than failing silently.

**Numbers that stack get `tabular-nums`.** Column counts, WIP caps, issue keys,
version numbers, metric rows. Not prose — that is what `.num` is for.

**The live query is the render source of truth.** A saved view is a stored
query; the bar edits a clone. "Saved" and "showing" can differ, and the
difference is always visible — the bar offers both ways out.

**A supplied `baseVersion` is enforced for every author.** That is what makes
the conflict banner real: a human drag that races an agent write is refused
rather than silently winning. The human/AI asymmetry is about ownership (only
AI writes are refused on a locked item's fields), not about staleness.

**Nothing destructive strands a row.** A board that still owns issues refuses to
be deleted, and so does undoing the creation of a board work has since been moved
onto — `InUseError` carries the count. Deleting an epic releases its children;
deleting a project takes its oplog with it; a delete snapshot carries the item's
labels and its relations in *both* directions, because the incoming edges live on
the other row.

**Order is written in the domain the board sorts by.** `view_item_rank` is
sparse, so a neighbour may still be ordered by `items.rank`; a drop computes its
new rank from `ranks[id] ?? item.rank`, and renumbers the whole column when a
midpoint is impossible (every card at the default rank 0). The order write waits
on the field write, so a refused move leaves no rank behind.

## Keyboard

| Key | Action |
|---|---|
| `⌘K` | Command palette — the primary navigation |
| `⌘N` / `N` | New issue (`N` opens the sheet; each column also has an inline composer) |
| `⌘P` | Project switcher |
| `⌘J` | Toggle the assistant panel |
| `⌘,` | Settings |
| `⌘Z` | Undo the last write, agent or human |
| `Enter` / `Space` | Open the focused card |
| `←` / `→` | Move the focused card one column |
| `Esc` | Close, innermost first — dialog → expanded detail → detail pane |

## Accessibility floor

WCAG 2.2 AA. `--meta` on `--surface-warm` resolves to 4.34:1, so small labels
on hovered and current rows step up to `--muted` (6.6:1) — check that pairing
whenever you add a label to a warm surface. Radix supplies the focus traps and
focus restore; the toast stack is `role="status" aria-live="polite"` and its 6s
countdown holds while hovered or focused. `prefers-reduced-motion: reduce`
strips every transition, including an explicit unwind of the theme crossfade's
`!important`.

Known gap, carried over from the design: chrome icon buttons are ~28px, which
clears 2.5.8 AA (24×24) but is under the 2.5.5 enhanced target (44×44).

## Divergences from the prototype

| Prototype | Here | Why |
|---|---|---|
| `design/board-settings.html` says "a board is a saved view … the same issue can appear on any number of boards" | A board owns its issues | The standalone file is the older model. `workspace-board.html`'s in-page dialog, `DESIGN.md` §3 and the prototype's own TOM-142 all say the board is the container. |
| `DESIGN.md` §3 says views are tabs over the board | No tab strip | The prototype never built one; its CSS says "There is no view picker in the chrome". Views are reached from the palette, the board-settings roster and the breadcrumb. |
| Settings says "one project is one SQLite file" | One file holds every project | Storage layout was out of scope for a UI rebuild; the copy was changed to match reality. |
| `--space-10` / `--space-12` declared only in `workspace-board.html` | Declared once, for all screens | The other five prototype files silently lost `.wrap` padding. |
| Prototype toasts print `now ago` | `now` stays bare | `agoLabel()` in `domain.ts`. |
| Epics are a separate map, never cards | Epics are items with `kind: 'epic'`, filtered out of every board render and count | One entity, one write path. `isTicket()` in `domain.ts` is the single place it is enforced. |
| Prototype hand-rolls its focus trap and Escape stack | Radix owns both | Radix makes the rest inert and restores focus; the workspace's Escape handler defers to `defaultPrevented`. The expanded detail is a real `role="dialog"`, not an overlay that only looks like one. |

## Verifying a change

`pnpm --filter @tomrade/desktop test:ui` drives the real UI against real
repositories over a throwaway database seeded with the prototype's sample
project (`apps/desktop/scripts/seed.mjs`). It asserts 81 behaviours and writes
a screenshot per screen and per theme into `apps/desktop/scripts/shots/`.
It needs the dev server up: `pnpm dev:ui`.
