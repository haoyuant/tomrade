// Builds the Tomrade Ledger design-system files from the tomrade repo (read-only).
// usage: node build-ds.mjs <repoRoot> <outDir>
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const [repo, out] = process.argv.slice(2);
const S = path.join(repo, "packages/ui/src/styles");
const read = (p) => fs.readFileSync(path.join(S, p), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ── parse declarations of a selector block ───────────────────────────────
function blocks(css) {
  const out = [];
  const src = stripComments(css);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
function decls(body) {
  const map = new Map();
  for (const part of body.split(/;(?![^(]*\))/)) {
    const mm = /^\s*--([A-Za-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (mm) map.set(mm[1], mm[2].replace(/\s+/g, " "));
  }
  return map;
}
function themeVars(file, selector) {
  const all = blocks(read(file));
  const b = all.find((x) => x.sel === selector) ?? all.find((x) => x.sel.split(",").map((s) => s.trim()).includes(selector));
  if (!b) throw new Error(`no ${selector} in ${file}`);
  return decls(b.body);
}

const paper = themeVars("theme/paper.css", ":root");
const scales = (() => {
  const src = stripComments(read("theme/scales.css"));
  const m = /@theme\s*\{([\s\S]*?)\n\}/.exec(src);
  return decls(m[1]);
})();
// the order of the app's theme picker (lib/theme.tsx); Sunrise is the default for new users
const themes = [
  { id: "sunrise", name: "Sunrise", vars: themeVars("theme/sunrise-daybreak.css", ".sunrise"), cls: "sunrise" },
  { id: "daybreak", name: "Daybreak", vars: themeVars("theme/sunrise-daybreak.css", ".daybreak"), cls: "daybreak" },
  { id: "glass", name: "Glass", vars: themeVars("theme/glass.css", ".glass"), cls: "glass" },
  { id: "sakura", name: "Sakura", vars: themeVars("theme/sakura.css", ".sakura"), cls: "sakura" },
  { id: "dawn", name: "Dawn", vars: themeVars("theme/dawn.css", ".dawn"), cls: "dawn" },
  { id: "paper", name: "Paper", vars: paper, cls: null },
  { id: "ink", name: "Ink", vars: themeVars("theme/ink.css", ".dark"), cls: "dark" },
  { id: "matcha", name: "Matcha", vars: themeVars("theme/matcha.css", ".matcha"), cls: "matcha" },
];

// ── colour tokens, in the source's order ─────────────────────────────────
const COLOR_USAGE = {
  bg: "Window ground behind the panes: the board canvas, the projects home, the status bar's page.",
  surface: "Raised panes and objects: sidebar, cards, detail pane, dialogs, menus, the titlebar.",
  "surface-warm": "Hover and current-row fill, secondary button, neutral tag fill. Labels on it use `muted`, never `meta`.",
  fg: "Primary text, titles and icons on `bg`, `surface` and `surface-warm`.",
  "fg-2": "Reading copy: descriptions and `.prose` on `surface` and `bg`.",
  muted: "Secondary labels, and every small label on `surface-warm` (hovered and current rows).",
  meta: "Timestamps, counts, eyebrows and issue keys on `bg` and `surface`. Paper: only 4.34:1 on `surface-warm`, so labels there step up to `muted` (kept exact from the source).",
  border: "Hairlines between panes and around cards and dialogs; also `elev-ring`.",
  "border-soft": "Inner rules inside a pane: table rows, list separators, the tab close hover.",
  "border-input": "Edges of inputs, selects and checkboxes: 3:1 against the page (WCAG 1.4.11).",
  accent: "The one brand colour per theme: the solid primary button, the current-view marker, links, stat numbers. One solid button per viewport, per action.",
  "accent-on": "Text and icons on an `accent` fill.",
  "accent-light": "A lighter accent for run marks in the status bar and the new badge; never body text.",
  "accent-hover": "Alias of `accent`: hover keeps the accent; a solid button's hover changes to `accent-active`.",
  "accent-active": "Pressed and hovered solid fills, and the focus ring. On dark themes it is LIGHTER than `accent`, so contrast rises on state change.",
  success: "Live dots, ready checks, success text. Always paired with a word or glyph.",
  warn: "WIP-cap overruns, changed-file marks, the warning banner. Always paired with a word or glyph.",
  danger: "Destructive actions and errors. Always paired with a word or glyph.",
  "term-bg": "A terminal's own dark quoted inside a pane (agent drawer, run tail), the same under every theme.",
  "term-fg": "Text on `term-bg`.",
  "term-dim": "Secondary text on `term-bg`.",
  "tag-bg-faint": "Faint tag fill and drag-over wash (hashtags, a file row a drop will land on).",
  "tag-bg-soft": "Selected file rows and soft tags.",
  "tag-bg-base": "Default tag fill; the query bar's open, active chip.",
  "tag-bg-strong": "Strong tag; search-hit highlight; tag-chip hover.",
  "tag-fg": "Text on every `tag-bg-*` fill.",
};
const colorNames = [];
for (const [k, v] of paper) if (!/^(space-|elev-|focus-|motion-|titlebar-|statusbar-|sidebar-w|detail-w|overlay-|traffic-|font-weight)/.test(k)) colorNames.push(k);
const toColor = (v) => {
  const a = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (a) return `{${a[1]}}`;
  return v.startsWith("#") ? v.toLowerCase() : v;
};
const colorTokens = colorNames.map((name) => {
  const value = {};
  for (const t of themes) {
    const v = t.vars.get(name) ?? paper.get(name);
    value[t.id] = toColor(v);
  }
  const allSame = Object.values(value).every((x) => x === value[themes[0].id]);
  let usage = COLOR_USAGE[name];
  const ch = /^chart-(\d+)$/.exec(name);
  if (ch) usage = `Categorical data-viz series ${ch[1]}. Charts use separate hues in order, never the accent alone.`;
  if (!usage) throw new Error("no usage for " + name);
  return { name, value: allSame ? value[themes[0].id] : value, usage };
});

// ── shadows (resolved per theme; tokens.json takes no var()) ──────────────
const resolve = (t, v) => v.replace(/var\(--([a-z0-9-]+)\)/g, (_, n) => {
  const x = t.vars.get(n) ?? paper.get(n);
  return x.startsWith("var(") ? resolve(t, x) : x;
});
const shadowTok = (name, usage) => {
  const value = {};
  for (const t of themes) value[t.id] = resolve(t, t.vars.get(name) ?? paper.get(name));
  return { name, value, usage };
};
const shadows = [
  shadowTok("elev-ring", "Level 1: a 1px ring in `border` instead of a drop shadow. Cards and panes at rest."),
  shadowTok("elev-ring-accent", "A 1px ring in `accent`: the selected card, a drop target."),
  shadowTok("elev-raised", "Level 2: what floats over the board: menus, the palette, dialogs, toasts."),
  shadowTok("focus-ring", "Keyboard focus on every control (2px `accent-active`, plus a halo on Sunrise, Daybreak, Sakura and Glass)."),
];

// ── spacing, radius, type and other scales ────────────────────────────────
const SPACE_USAGE = {
  "space-1": "Icon-to-label gaps, chip padding.", "space-2": "Gaps inside a row; card foot gaps.", "space-3": "Card padding; the 12px window gutter (titlebar, sidebar, right edge).",
  "space-4": "Pane padding; gaps between columns.", "space-5": "Detail pane side padding.", "space-6": "Section gaps inside a pane.", "space-7": "Dialog padding.",
  "space-8": "Overlay margin from the workspace edges.", "space-10": "Page gutters on the projects home.", "space-12": "Large page sections.",
};
const spacing = [...paper].filter(([k]) => k.startsWith("space-")).map(([name, value]) => ({ name, value, usage: SPACE_USAGE[name] }));
const RADIUS_USAGE = {
  "radius-xs": "Hairline marks and tiny chips.", "radius-sm": "Buttons, inputs, tags, focus ring corners.", "radius-md": "Cards, menus, the composer.",
  "radius-lg": "Dialogs, project cards, the palette.", "radius-xl": "The expanded issue sheet and large sheets.",
};
const radius = [...scales].filter(([k]) => k.startsWith("radius-")).map(([name, value]) => ({ name, value, usage: RADIUS_USAGE[name] }));
const TEXT_USAGE = {
  "text-xs": "Eyebrows, issue keys, counts, tags, the status bar.", "text-sm": "UI labels: sidebar rows, buttons, menus, card meta.", "text-base": "Body: card titles, prose, inputs.",
  "text-md": "Emphasised body; dialog lede.", "text-lg": "Board and pane titles.", "text-xl": "Detail title, project names, settings section titles.", "text-2xl": "The expanded issue title and page titles.",
};
const textSizes = [...scales].filter(([k]) => k.startsWith("text-")).map(([name, value]) => ({ name, value, usage: TEXT_USAGE[name] }));
const LEADING_USAGE = { "leading-display": "Display lines.", "leading-tight": "Titles and headings.", "leading-body": "Reading copy.", "leading-dense": "Dense lists and table rows.", "leading-card": "Card titles only: two-line fragments, a documented exception below kami's 1.40 floor." };
const leading = [...scales].filter(([k]) => k.startsWith("leading-")).map(([name, value]) => ({ name, value, usage: LEADING_USAGE[name] }));
const tracking = [...scales].filter(([k]) => k.startsWith("tracking-")).map(([name, value]) => ({ name, value, usage: name === "tracking-eyebrow" ? "Uppercase eyebrows." : "Issue keys and `.num` figures." }));
const CHROME_USAGE = { "titlebar-h": "Height of the titlebar.", "statusbar-h": "Height of the status bar.", "sidebar-w": "Default sidebar width (resizable).", "detail-w": "Docked detail pane width." };
const chrome = [...paper].filter(([k]) => CHROME_USAGE[k]).map(([name, value]) => ({ name, value, usage: CHROME_USAGE[name] }));

const fam = (n) => scales.get(`font-${n}`);
const type = {
  fonts: [],
  families: { display: fam("display"), body: fam("body"), mono: fam("mono") },
  groups: [
    { name: "Display", family: "display", styles: [
      { name: "page-title", fontSize: "35px", lineHeight: 1.25, fontWeight: 500, sample: "Command palette over boards, views, issues and actions", usage: "`--text-2xl`: the expanded issue title (`.issue-title`, `.detail.expanded .detail-title`)." },
      { name: "section-title", fontSize: "24px", lineHeight: 1.25, fontWeight: 500, sample: "Tomrade", usage: "`--text-xl`: project names, the docked detail title, settings section titles." },
      { name: "pane-title", fontSize: "19px", lineHeight: 1.25, fontWeight: 500, sample: "Backlog", usage: "`--text-lg`: the board title and pane heads." },
    ] },
    { name: "Text", family: "body", styles: [
      { name: "body", fontSize: "15px", lineHeight: 1.55, fontWeight: 400, sample: "One palette spanning every board-view pair, every issue and every action.", usage: "`--text-base` at `--leading-body`: prose and descriptions, in `fg-2`." },
      { name: "card-title", fontSize: "15px", lineHeight: 1.32, fontWeight: 400, sample: "Inline column composer; retire the New Ticket modal", usage: "`--text-base` at `--leading-card`: card titles only." },
      { name: "label", fontSize: "13px", lineHeight: 1.4, fontWeight: 400, sample: "Recently updated", usage: "`--text-sm`: sidebar rows, buttons, menus, field values." },
      { name: "eyebrow", fontSize: "12px", lineHeight: 1, fontWeight: 400, letterSpacing: "1.2px", sample: "WORK TYPE", usage: "`.eyebrow`: uppercase, `--tracking-eyebrow`, in `meta`." },
    ] },
    { name: "Mono", family: "mono", styles: [
      { name: "issue-key", fontSize: "12px", lineHeight: 1.4, fontWeight: 400, letterSpacing: "0.4px", sample: "TOM-1045", usage: "`.card-id`, `.num`: issue keys, counts, versions, ports. Tabular figures." },
    ] },
  ],
};

let ref = "";
try { ref = execSync(`git -C '${repo}' rev-parse --short HEAD`).toString().trim(); } catch {}
const tokens = {
  name: "Tomrade Ledger",
  version: 1,
  meta: {
    source: "github", repo: "haoyuant/tomrade", ref: `main@${ref}`, package: "packages/ui",
    paths: { tokens: ["packages/ui/src/styles/theme/"], css: ["packages/ui/src/styles/"], assets: ["apps/desktop/assets/icon.png", "packages/ui/src/components/icons.tsx"], docs: ["docs/design-system.md", "design/DESIGN.md"] },
    synced: new Date().toISOString().slice(0, 10),
  },
  color: { themes: themes.map(({ id, name }) => ({ id, name })), tokens: colorTokens },
  type,
  spacing: { tokens: spacing },
  radius: { tokens: radius },
  shadow: { note: "Elevation is a ring first, a shadow only for what floats.", tokens: shadows },
  text: { note: "The type scale as custom properties (`--text-*`), kami × ~1.09 for UI density. Do not restore kami's print values.", tokens: textSizes },
  leading: { tokens: leading },
  tracking: { tokens: tracking },
  chrome: { note: "Electron shell geometry, not brand values.", tokens: chrome },
};

// ── bundle.css: the app's own rules, theme classes → data-theme ───────────
const order = [];
for (const line of read("app.css").split("\n")) {
  const m = /^@import "\.\/(.+?)";/.exec(line);
  if (m && !m[1].startsWith("theme/")) order.push(m[1]);
}
const extra = ["layouts.css", "sunrise.css", "glass.css", "sakura.css", "backdrop.css", "motion.css"];
const themeSel = (css) => css
  .replace(/\.dark\b/g, '[data-theme="ink"]')
  .replace(/\.(matcha|dawn|sunrise|daybreak|glass|sakura)\b(?![-_])/g, '[data-theme="$1"]');

// what tokens.json cannot hold: theme-invariant motion, weights, overlay maths,
// per-theme font and radius swaps, and the scene layers' own colours
const sceneVars = (t, keep) => [...t.vars].filter(([k]) => keep(k)).map(([k, v]) => `  --${k}: ${v};`).join("\n");
const isCoreColor = (k) => colorNames.includes(k) || ["elev-raised", "elev-ring", "elev-ring-accent", "focus-ring"].includes(k);
let head = `/* Tomrade Ledger — components/bundle.css, generated from packages/ui/src/styles @ ${ref}.
   Load after tokens.css. Themes switch by data-theme="<id>" on any ancestor
   (the app puts a class on <html>; here .dark → [data-theme="ink"], .matcha → [data-theme="matcha"], …). */
@layer theme, base, components, utilities;

:root, [data-theme] {
  --font-weight-regular: ${paper.get("font-weight-regular")};
  --font-weight-medium: ${paper.get("font-weight-medium")};
  --motion-fast: ${paper.get("motion-fast")};
  --motion-base: ${paper.get("motion-base")};
  --ease-standard: ${scales.get("ease-standard")};
  --overlay-mid: ${paper.get("overlay-mid")};
  --overlay-max-h: ${paper.get("overlay-max-h")};
  --traffic-inset: var(--space-3);
}
`;
const fontSwap = themeVars("theme/sunrise-daybreak.css", ".daybreak");
const fontSwapAll = blocks(read("theme/sunrise-daybreak.css")).find((b) => b.sel.replace(/\s+/g, "") === ".sunrise,.daybreak,.glass");
for (const [k, val] of decls(fontSwapAll.body)) fontSwap.set(k, val);
head += `[data-theme="sunrise"], [data-theme="daybreak"], [data-theme="glass"] {\n  --font-display: ${fontSwap.get("font-display")};\n  --font-body: ${fontSwap.get("font-body")};\n}\n`;
for (const t of themes) {
  const scene = sceneVars(t, (k) => !isCoreColor(k) && !k.startsWith("space-") && !["font-weight-regular", "font-weight-medium", "motion-fast", "motion-base", "titlebar-h", "statusbar-h", "sidebar-w", "detail-w", "overlay-mid", "overlay-max-h", "traffic-inset"].includes(k));
  if (scene && t.id !== "paper") head += `[data-theme="${t.id}"] {\n${scene}\n}\n`;
}
const glassFrost = blocks(read("theme/glass.css")).find((b) => b.sel === ".glass[data-frosted]");
if (glassFrost) head += `[data-theme="glass"][data-frosted] {${glassFrost.body}}\n`;

// the preflight the app's own Tailwind import puts in its base layer, from the version packages/ui resolves
const uiRequire = createRequire(path.join(repo, "packages/ui/package.json"));
const twDir = path.dirname(uiRequire.resolve("tailwindcss/package.json"));
const twVersion = JSON.parse(fs.readFileSync(path.join(twDir, "package.json"), "utf8")).version;
const pre = fs.readFileSync(path.join(twDir, "preflight.css"), "utf8");
let css = head + `\n/* ── tailwindcss@${twVersion} preflight (the app's base layer) ── */\n` + "@layer base {\n" + pre + "\n}\n";
// window-width rules fire inside narrow preview frames; they ship beside the bundle, opt-in
for (const f of [...order, ...extra]) if (f !== "state/responsive.css") css += `\n/* ── ${f} ── */\n` + themeSel(read(f));
fs.mkdirSync(path.join(out, "project/components"), { recursive: true });
fs.writeFileSync(path.join(out, "project/components/responsive.css"), `/* Tomrade Ledger — the app's window-width rules (state/responsive.css @ ${ref}). Load after bundle.css only on full-window screens. */\n` + themeSel(read("state/responsive.css")));
if (/<\/style/i.test(css)) throw new Error("</style in css");

fs.mkdirSync(path.join(out, "project/components"), { recursive: true });
fs.writeFileSync(path.join(out, "project/components/bundle.css"), css);
fs.writeFileSync(path.join(out, "project/tokens.json"), JSON.stringify(tokens, null, 2) + "\n");

// tokens.css laid out as the page compiles it (for the canvas copy)
const v = (x) => (typeof x === "string" && x.startsWith("{") ? `var(--${x.slice(1, -1)})` : x);
let tc = `/* Tomrade Ledger — generated from tokens.json */\n:root, [data-theme="${themes[0].id}"] {\n`;
for (const t of [...colorTokens, ...shadows]) tc += `  --${t.name}: ${v(typeof t.value === "string" ? t.value : t.value[themes[0].id])};\n`;
tc += "}\n";
for (const th of themes.slice(1)) {
  tc += `[data-theme="${th.id}"] {\n`;
  for (const t of [...colorTokens, ...shadows]) if (typeof t.value !== "string") tc += `  --${t.name}: ${v(t.value[th.id])};\n`;
  tc += "}\n";
}
tc += ":root {\n";
for (const t of [...spacing, ...radius, ...textSizes, ...leading, ...tracking, ...chrome]) tc += `  --${t.name}: ${t.value};\n`;
for (const [k, val] of Object.entries(type.families)) tc += `  --font-${k}: ${val};\n`;
tc += "}\n";
// not part of the system (its page compiles its own): the copy a Design canvas installs beside it
fs.writeFileSync(path.join(out, "tokens.css"), tc);
console.log("colors", colorTokens.length, "themes", themes.length, "bundle.css", css.length, "bytes; ref", ref);
