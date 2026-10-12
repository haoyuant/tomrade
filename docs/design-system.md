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
| Icon sprite (64 symbols, inline SVG) | `packages/ui/src/components/icons.tsx` |
| Domain vocabulary: statuses, priorities, grouping, the live query | `packages/ui/src/lib/domain.ts` |
| Primitives on Radix, styled by the design's classes | `packages/ui/src/components/ui/` |
| Theme resolution and the crossfade | `packages/ui/src/lib/theme.tsx` |
| Toasts, including the hold-on-hover countdown | `packages/ui/src/lib/toast.tsx` |
| Every call into the main process | `packages/ui/src/lib/api.ts` + `queries.ts`, typed by the channels plugins contribute (`@tomradex/ipc`) |
| Plugin contributions: palette commands, card badges, status items, detail sections, settings cards, assistant accessories | rendered where each lives — `CommandPalette.tsx`, `Card.tsx`, `StatusBar.tsx`, `DetailPane.tsx`, `SettingsDialog.tsx`, `PetStage.tsx` — from data, never from plugin React code |

## Tokens

Four themes, one declaration set. Dawn (`.dawn`) is the default: warm paper,
vermilion accents, and brown ink, drawn from the login poster. `:root` is Paper;
`.dark` (Ink), `.matcha`, and `.dawn` override the colour tokens that vary.
Saved theme preferences remain in effect. Everything else —
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

**The backlog is one dataset; a view is a saved way of looking at it.** Every
attribute an issue has is a *field* — built-in (status, priority, epic, labels,
workstream, updated…) or one the project added — and a view is a *layout*
(Board, Table, Graph) plus a query over fields: filter, column by, group by
(swimlanes), sort by, the fields shown. Workstream is a field like the others:
`items.board_id` stores it, a Workstream column or swimlane writes it on drop,
and the Fields sheet is where its options are renamed and retired. The sidebar
answers "which view", never "which container".

**Leaving a project is titlebar chrome.** The sidebar holds the project's
files, its views and the door to its fields, and nothing else. Home *leaves* the project, the switcher
*rebinds* it — two jobs, two controls, separated by a hairline not a slash.
Configuring one is chrome too: the switcher's foot inside a project, the card's
own gear on the projects grid, and nowhere in the sidebar.

**A file is a place, like a view.** The Files tree is the sidebar's first
group: folders fold (the chevron), a row opens `f/$path` and takes the board's
place with the same head geometry, and no view reads as current while a file
is open. Reading renders markdown through a sanitizer — wiki links and tags as
the app's own links, a link to nothing marked as one — HTML in a frame with an
empty `sandbox`, everything else as text or a picture. Writing is the latest
version of a text file only, behind a Read/Edit switch the machine remembers —
Read/Edit/Split where the file renders as something other than its text
(markdown, HTML, SVG): Split halves the full width between the editor and a
live preview that keep each other's place by source line. Every save is a version guarded by the hash it was read at, so a save that
would land over somebody else's stops and offers Keep mine, Take theirs or
Keep both. A version is immutable: a ticket's artifact opens the version it
pinned and says so in a banner. A file changed on two machines is a decision,
drawn with both sides whole, never a silent winner.

**A ticket's description is Markdown that reads as text.** GFM with a single
newline kept as a line break, as on GitHub; task boxes are drawn, not inputs.
A click on the text (not on a link, not after selecting) opens the source in
the same CodeMirror look as a note, with Write/Preview, ⌘↵ to save and Escape
to discard; leaving the frame saves. Files pasted, dropped or added are drafts
in memory until the save, then one version under
`<workstream>/attachments/<KEY>/`, linked as `tomrade-file://<fileId>` so a
rename in Files never touches the body. A body that changed while it was open
is never written over: the editor says so and offers Keep mine or Take theirs.

**Both side panes fold to the same 48px rail, and remember it.** `⌘B` for the
sidebar, `⌘J` for the assistant, each persisted per machine (`usePanelOpen`). A
railed sidebar takes the board list with it, so the board head grows the same
switcher it grows under 990px — the palette is never the only way to change
board.

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
layout and query; the bar and the layout switch edit a draft. "Saved" and
"showing" can differ, and the difference is always visible — the bar offers
Save view, Discard and Save as new, and nothing saves behind the user's back.

**A supplied `baseVersion` is enforced for every author.** That is what makes
the conflict banner real: a human drag that races an agent write is refused
rather than silently winning. The human/AI asymmetry is about ownership (only
AI writes are refused on a locked item's fields), not about staleness. Both
rules are listeners on `write/pre-commit`, loaded by the `write-policy` row in
`tomrade.yml` — the compiler will not stop you removing the row, and the tests
in `packages/write` show what that costs.

**A plugin badge is a tag, never a mark.** The card gutter belongs to
provenance. Contributed badges render in the card foot beside the labels, in
the tag tones the design already has; a plugin cannot put anything in the gutter.

**Nothing destructive strands a row.** A workstream that still holds issues, or
is the project's last, refuses to be deleted, and so does undoing the creation of
one that work has since been moved onto — `InUseError` carries the count; a
project's last view refuses to go for the same reason. Deleting *or purging* an epic releases its
children; deleting a project takes its oplog with it — items, boards, views and
any purge tombstone naming it, which is why those sweeps run *before* the rows
they scope through are deleted; a delete snapshot carries the item's labels and
its relations in *both* directions, because the incoming edges live on the other
row.

**Reversible by default; permanent only on purpose.** Agents get `delete`, which
leaves the snapshot undo restores from. Only a human reaches `purge`, and the
write policy (`humanOnlyPurge` on `write/pre-commit`) refuses any other author
rather than trusting the IPC boundary to.
A purge removes the item's *own* oplog rows and leaves one tombstone carrying
`{key, title, projectId, releasedChildren}` — enough to name what happened, never
enough to rebuild it — so no earlier `update` snapshot can put the row back
either. `undoLast` walks straight past a tombstone to the write before it. The
confirmation asserts the version it was rendered from, because a promise about a
title an agent has since rewritten is not a confirmation, and here there is no
undo to fall back on.

**Two irreversible writes, and each asks in the words it will be judged by.**
Purging an issue asks for one click on a sheet that names the version it was
rendered from. Deleting a project asks for its name in writing, because it takes
every board, view and issue inside it *and* the oplog rows those issues wrote —
a project is not in the oplog at all, so unlike a purge it leaves no tombstone
and nothing for `⌘Z` to walk back to. The confirmation is the *second face* of
the project-settings sheet rather than a second dialog: one focus trap, one
scrim, and Escape steps back to the settings instead of out. Its counterpart on
the way in: `ensureDefault()` is a first-run seed, not a repair — it writes the
`default` project only into an *empty* projects table, so a project a human
deleted does not reappear on the next boot.

The corollary nothing in the compiler enforces: a *surviving* snapshot can still
name a purged row. `restoreItem` therefore nulls a dangling `parent_id` and skips
a dangling edge — testing the tombstone, not whether the row is there right now,
because a *soft*-deleted counterpart is coming back the moment someone undoes
that delete and must still round-trip.

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
| `⌘B` | Toggle the sidebar |
| `⌘,` | Settings |
| `⌘E` | On a text file, switch between reading and the last way of writing (Edit or Split) |
| `⌘S` | In the editor, save now (a pause and leaving the file save too) |
| `⇧⌘F` | Search the project's notes, in the sidebar |
| `⌘Z` | Undo the last write, agent or human — a permanent delete is not a write it can reach |
| `Enter` / `Space` | Open the focused card |
| `←` / `→` | Move the focused card one column |
| `Esc` | Close, innermost first — dialog → expanded detail → detail pane. On the delete confirmation it cancels, never confirms |

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
| `design/board-settings.html` says "a board is a saved view … the same issue can appear on any number of boards" | A workstream is a field value; a view is a saved query | The prototype's board was the container; since Sep 2026 the container is the project and "board" names a layout, the way GitHub Projects uses the word. |
| `DESIGN.md` §3 says views are tabs over the board | Views are the sidebar's rows | One list, any layout; the tab strip the prototype never built is not needed once the sidebar stopped holding containers. |
| Settings says "one project is one SQLite file" | One file holds every project | Storage layout was out of scope for a UI rebuild; the copy was changed to match reality. |
| `--space-10` / `--space-12` declared only in `workspace-board.html` | Declared once, for all screens | The other five prototype files silently lost `.wrap` padding. |
| Prototype toasts print `now ago` | `now` stays bare | `agoLabel()` in `domain.ts`. |
| Epics are a separate map, never cards | Epics are items with `kind: 'epic'`, filtered out of every board render and count | One entity, one write path. `isTicket()` in `domain.ts` is the single place it is enforced. |
| Prototype hand-rolls its focus trap and Escape stack | Radix owns both | Radix makes the rest inert and restores focus; the workspace's Escape handler defers to `defaultPrevented`. The expanded detail is a real `role="dialog"`, not an overlay that only looks like one. |

## Verifying a change

`pnpm --filter @tomrade/desktop test:ui` boots the same plugin tree the app
does — `apps/desktop/tomrade.yml`, patched to run MCP on a free port and the
cloud Hub off, since the harness never signs in — over a throwaway database
seeded with the prototype's sample project (`apps/desktop/scripts/seed.mjs`).
It asserts 338 behaviours — among them the Markdown description: rendered
task boxes and line breaks, a click into its editor but not through a link,
Preview, ⌘↵ and Escape (which leaves the pane, and the expanded overlay, open),
and a save over a body an agent changed meanwhile, refused until Keep mine —
and writes a screenshot per screen and per theme into
`apps/desktop/scripts/shots/`. It needs the dev server up (`pnpm dev:ui`) *and*
a built backend — it loads `apps/desktop/dist` and every plugin's `dist`, so a
new channel is invisible to it until `pnpm build:backend` has run.
`test:files` (`scripts/files-check.mjs`) drives the Files screen the same way:
the tree, the viewer and its versions, a clash with a second machine over a
local bare remote, importing a folder whole, pinning multiple files to a ticket
and bringing a file in for one so it lands in its workstream's folder,
undoing a delete from its toast, ⇧⌘Z, ⌘Z and the History window (title bar, beside Settings),
and selective sharing — the project default in Sharing, the cloud, monitor and
half-cloud marks after names and their sources, the bulk chooser, context menus that offer only what would change,
the keep-local review, and a scoped remote that receives one shared exception
with its version record while its siblings stay untouched. It also covers the
agent index: a crossed-out eye on the exception alone, the two settings side by
side above a folder, a withheld path leaving the index while it still reads by
path, and the preview in Sharing that shows the person the very text an agent
receives — and files pasted or dropped into a ticket's description: held as
drafts the preview draws from memory, nothing written on Escape, one version
under `<workstream>/attachments/<KEY>/` on save with the body linking each by
id, the image still drawn after a move in Files, and the agent index leaving
attachments out — 114 checks.
`test:notes` (`scripts/notes-check.mjs`) drives writing in place: links and tags
in the reading view, pictures of the store inside a note, backlinks and turning
an unlinked mention into a link, a dangling link that starts its note, typing
that saves on a pause, `[[` completion, ⌘S, ⌘Z and Ctrl chords staying inside
the editor, an outside save shown at once and one that clashes with unsaved
edits, a delete under unsaved edits, leaving an unanswered clash (yours kept as
a copy), a CRLF file saved with its own line endings, a rename that rewrites
the links to it, the sidebar search and a tag clicked into it, ⇧⌘F, Today's
note, New note, the palette as a quick switcher and its offer to search the
notes, ⌘E, Split (live preview, equal halves, the editor kept across the
switch, scrolling either half brings the other to the same section, an HTML
page, plain text without one), and the editor in the dark — 59 checks.
`test:plugins-ui` (`scripts/plugins-ui-check.mjs`) drives the Plugins pane: a
store package and a local one with their tiers, risk and reach, an agent's
build that loads only from the review dialog, My plugins and a new plugin from
a description, Browse when the store is unreachable, Installed grouped by
contract and narrowed by its search box, the Assistant pane's link to the
engines that are switched off, and the pane in Chinese — 32 checks. `test:extensions` (8) installs a plugin from outside the app and
reloads a development folder in the real shell.
`test:restore` (`scripts/restore-check.mjs`) plays two computers: a child
process makes projects on the old one and backs three up to local bare remotes;
the new one boots with nothing but the Hub catalog. Every project in the
catalog shows on the home screen at once — restoring (step and running rule),
waiting, offline, not published yet, needing an account, never backed up —
the backed-up ones come back with every issue unprompted, the untouched first-run
sample project makes way and never reaches the catalog, Retry lands where it
was, connecting the account in place resumes the restore by itself, the card's
gear opens the project's sheet where one nobody can find the folder of is
removed from the catalog after one confirmation (Cancel focused, Cancel goes
back) and stays removed, a located folder becomes the project and its arrival
is announced, and the Hub pane lists the same — 47 checks.
`test:updates` (`scripts/updates-check.mjs`) points the updater at a feed served
from the check itself: the feed is asked at launch, a newer release is announced
by a notice and not downloaded, Later keeps it away, the About pane says the same with Download and
both settings, turning automatic checks off stops the asking, Beta asks its own
feed and forgets Stable's answer, a missing feed is reported with its reason, an
older build on the feed is never offered, turning checks back on asks at once,
and no notice is stacked over the open About pane — 25 checks. The restart
itself only runs in an installed build (docs/releasing.md).
`test:local-cli` (`scripts/local-cli-check.mjs`) covers the local agents:
each engine reports how its CLI was looked for and, when found, its path and
version; a missing path is refused with its reason; with both agents signed
out, Start names why in a few words and its Set up opens Settings on that
agent's row, which shows the chosen file, the sign-in step and a short state;
a path that does not run is refused before it is saved, automatic detection
takes a chosen path back, Check again skips the cache, and a Windows CLI found
only in WSL gets its own warning, the full guide (`where codex` included) and
diagnostics naming the platform, the folders searched and PATH; the panel's
engine picker lists what can run first and greys the rest with a short reason
and Set up, which opens Settings on that engine (the models, for an engine with
none) and never switches or creates a thread; with nothing set up the setup card
offers a key and each agent's sign-in command (run in a terminal, or handed over
when there is none), its Check again finds Claude Code signed in meanwhile and
the card goes — Claude Code then conducts and lends its model for planning —
and with a model alone there is no card either, the built-in agent among what
can run; Start lists the built-in agent first — 50 checks.
`test:setup` (`scripts/setup-check.mjs`) connects an AI on a first run against a
stand-in DeepSeek: the screen before the projects finds a key exported in the
shell, masked, says in plain words why a pasted key is refused and saves
nothing, connects the found key as the first profile on a model the provider
lists, says what that unlocked and opens the sample project, and the built-in
agent — the bundled Pi, run by Electron as Node — takes a turn that calls
Tomrade's tools with the key only in its environment — 15 checks.
`test:onboarding` (`scripts/onboarding-check.mjs`) is a first run left alone:
the app opens on the sample project and nothing else, its seed absent from
History and from the account's catalog; before the projects it asks to connect
an AI, guesses a pasted key's provider and can be told "later"; its Learning
path view draws as a graph; the assistant keeps a setup card that offers a key
and cannot be put away; a run's first changes carry the hint about undoing
them, Start and the first dependency elsewhere are pointed out once each, and
all of it stays seen across a reload; deleted, the sample is offered again,
comes back in Chinese, and its offer can be put away for good; the home runs
onboarding again — setup screen and hints back, a sample made if there is none
or, when asked, put back as it began — and again a second time — 44 checks. The other checks set
`onboarding.seen: ["*"]` before the page loads, so no hint stands in their way,
and `TOMRADE_UI_WORK` gives `test:ui` a folder of its own when two checkouts run
it at once.
