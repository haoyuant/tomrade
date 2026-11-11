# Design system generators

These scripts rebuild **Tomrade Ledger**, the app's design system in Claude Design, from the code. The screens canvas, **Tomrade Screens**, installs that system and draws every screen with its tokens and stylesheet, so a style change reaches it after a rebuild and a reinstall.

```sh
pnpm design-system            # writes out/design-system (ignored by git)
```

They only read the repository:

| Script | Reads | Writes under `out/design-system` |
|---|---|---|
| `build-icons.mjs` | `packages/ui/src/components/icons.tsx` | `project/components/icons.svg` (the sprite), `icons/*.svg` (one inked file per symbol, for the asset groups), `icons.json` |
| `build-ds.mjs` | `packages/ui/src/styles/theme/*.css`, the files `app.css` imports, Tailwind's preflight from `packages/ui`'s own dependency | `project/tokens.json` (8 themes in the order of `lib/theme.tsx`, Sunrise first), `project/components/bundle.css` (the app's stylesheet, theme classes rewritten to `[data-theme]`), `project/components/responsive.css` (the window-width rules, opt-in), `tokens.css` (the copy a canvas installs) |
| `build-components.mjs` | `icons.json` | `project/components/<Comp>/README.md` and `preview.html` for 21 components |
| `build-screens.mjs` | `screens/screens.html`, `screens/parts.html`, `icons.json` | `canvas/project/`: one `.dc.html` per screen, `Main.dc.html` (the screen index), `canvas.json` (pages and layout), `ds/tomrade/tokens.css`; `canvas/preview/` holds plain pages for a local look |

`build.mjs` runs the four in order.

## Screens

`screens/screens.html` is the list of screens. Each `<!--@screen ID|area|name|state|theme|about-->` block is one artboard: `W01-Board.dc.html`, titled "W-01 · Board", placed on its area's page in ID order and listed in the index. IDs: `W` workspace, `H` home, `S` settings; add an area in `AREAS` in `build-screens.mjs`.

What several screens share (titlebar, sidebar, view head and query bar, board columns, status bar, assistant) is written once in `screens/parts.html` and pulled in with `<!--@include name-->`. Cards are `[[card KEY|title|status|priority|workstream|age|provenance|epic:hue|labels]]`, icons `[[i-plus 14]]`. Markup uses the app's class names only, so the design system styles it.

## Republishing

1. Run `pnpm design-system` and compare `out/design-system/project` with what the system holds.
2. Publish only the files that changed to the system, under `project/`. Never overwrite its `design-system.json` from here: read it from the system, change only `lastChange`, and send it last. The README and component guidelines may have been edited on the system's page; keep those edits.
3. When an icon changed, upload its file from `icons/` as an asset and update its record in the index.
4. In the screens canvas, update the installed copy: `ds/tomrade/tokens.json`, `components/bundle.css`, `components/icons.svg` from the system, and `ds/tomrade/tokens.css` from `out/design-system/tokens.css`.
5. For the screens, run with the canvas's current index so its other keys and anyone's notes survive: `CANVAS_JSON=<downloaded canvas.json> pnpm design-system`. Publish the changed `.dc.html` files and `canvas.json`; remove the files the run reports as no longer on the canvas.

Component previews are static markup over the real CSS; when a component's markup changes in `packages/ui`, change it in `build-components.mjs` too.
