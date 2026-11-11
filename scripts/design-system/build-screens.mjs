// Builds the Tomrade Screens canvas from screens/screens.html and screens/parts.html.
// usage: node build-screens.mjs <outDir> [existing canvas.json]
//   <outDir>/icons.json must exist (build-icons.mjs writes it).
//   writes <outDir>/canvas/project/*.dc.html, canvas.json and ds/tomrade/tokens.css,
//   and <outDir>/canvas/preview/*.html, plain pages for a local look.
// One list drives everything: each `<!--@screen ID|area|name|state|theme|about-->` block is one artboard,
// its file name, its title, its place on its area's page and its row in the Index.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [outArg, existingCanvas] = process.argv.slice(2);
const out = path.resolve(outArg);
const syms = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(out, "icons.json"), "utf8")).map((s) => [s.id, s]));
const THEMES = ["sunrise", "daybreak", "glass", "sakura", "dawn", "paper", "ink", "matcha"];
const AREAS = [
  { id: "workspace", name: "Workspace", about: "Inside a project: the board, a ticket, the palette." },
  { id: "home", name: "Home", about: "Before a project is open." },
  { id: "settings", name: "Settings", about: "Sheets over the workspace." },
];
const W = 1440, H = 900, GAP = 80;

const parts = {};
for (const m of fs.readFileSync(path.join(here, "screens/parts.html"), "utf8").matchAll(/<!--@part (\S+)-->\n([\s\S]*?)<!--@end-->/g)) parts[m[1]] = m[2];

function expand(html, used) {
  html = html.replace(/<!--@include (\S+)-->/g, (_, n) => { if (!parts[n]) throw new Error("no part " + n); return parts[n]; });
  // cards: [[card key|title|status|prio|ws|date|prov|epic:hue|tags]]; a tag written !x is a plugin badge
  html = html.replace(/\[\[card ([^\]]+)\]\]/g, (_, a) => {
    const [key, title, status, prio, ws, date, prov, epic, tags] = a.split("|");
    const [wsIcon, ...wsName] = (ws || "").split(" ");
    const [epicName, hue] = (epic || "").split(":");
    const tagList = (tags || "").split(",").filter(Boolean);
    const gutter = prov === "ai" ? '<span class="prov-tick" style="height:17px"></span>' : prov === "lock" ? "[[i-lock 12 prov-lock]]" : "";
    const foot = epicName || tagList.length
      ? `<span class="card-foot">${epicName ? `<span class="tag card-epic" style="--epic-hue:${hue}">[[i-stack 11]]<span class="card-epic-name">${epicName}</span></span>` : ""}${tagList.map((t) => (t.startsWith("!") ? `<span class="tag">${t.slice(1)}</span>` : `<span class="tag neutral">${t}</span>`)).join("")}</span>`
      : "";
    return `<div class="card" role="button" tabindex="0"><span class="card-gutter">${gutter}</span><span class="card-body"><span class="card-meta">[[${status} 12 sdot${status === "s-done" ? " done" : ""}]]${prio ? `[[${prio} 12 prio${prio === "p-4" ? " urgent" : ""}]]` : ""}<span class="card-id">${key}</span>${ws ? `<span class="card-board">[[${wsIcon} 11]]${wsName.join(" ")}</span>` : ""}<span class="card-date">${date}</span></span><span class="card-title">${title}</span>${foot}</span></div>`;
  });
  // theme tiles: [[swatch id|Name|icon|current]], each drawn in its own theme's tokens
  html = html.replace(/\[\[swatch ([^\]]+)\]\]/g, (_, a) => {
    const [id, name, icon, cur] = a.split("|");
    const on = cur === "current";
    return `<button aria-pressed="${on}" style="display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid ${on ? "var(--accent)" : "var(--border)"};box-shadow:${on ? "var(--elev-ring-accent)" : "none"};border-radius:var(--radius-md);background:var(--surface);text-align:left"><span data-theme="${id}" style="display:flex;gap:6px;align-items:flex-end;height:64px;padding:8px;border-radius:var(--radius-sm);background:var(--bg);box-shadow:var(--elev-ring)"><span style="flex:1;height:100%;border-radius:var(--radius-xs);background:var(--surface);box-shadow:var(--elev-ring)"></span><span style="width:22px;height:12px;border-radius:var(--radius-xs);background:var(--accent)"></span></span><span class="row" style="font-family:var(--font-display);font-size:14px;color:var(--fg)">[[${icon} 13 meta]]${name}</span></button>`;
  });
  // icons: [[id size cls...]]; `accent` / `meta` colour the icon instead of naming a class
  html = html.replace(/\[\[([isp]-[a-z0-9-]+) (\d+)((?: [a-z-]+)*)\]\]/g, (_, id, size, cls) => {
    if (!syms[id]) throw new Error("no icon " + id);
    used.add(id);
    const classes = cls.trim().split(/\s+/).filter(Boolean);
    const style = classes.includes("accent") ? ' style="color:var(--accent)"' : classes.includes("meta") ? ' style="color:var(--meta)"' : "";
    const c = classes.filter((x) => x !== "accent" && x !== "meta").join(" ");
    return `<svg${c ? ` class="${c}"` : ""} width="${size}" height="${size}"${style} aria-hidden="true"><use href="#${id}"></use></svg>`;
  });
  if (/\[\[/.test(html)) throw new Error("unexpanded macro: " + html.match(/\[\[[^\]]*\]\]/)[0]);
  return html;
}

// the symbols a screen uses, mounted once at its root as the app mounts its sprite
const sprite = (used) => `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>\n${[...used].sort().map((id) => `<symbol id="${id}" viewBox="${syms[id].viewBox}">${syms[id].inner}</symbol>`).join("\n")}\n</defs></svg>`;
// the canvas's parser wants every element closed
const closeTags = (s) => s.replace(/<(path|rect|circle|line|polyline|polygon|ellipse|use)([^>]*?)\/>/g, "<$1$2></$1>");

const dcFile = ({ title, theme, root }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/tomrade/tokens.css">
<link rel="stylesheet" href="ds/tomrade/components/bundle.css">
</head>
<body>
<x-dc>
<helmet>
<style>
body{margin:0}
</style>
</helmet>
${root}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='${JSON.stringify({ theme: { editor: "enum", options: THEMES, default: theme, section: "Look" }, $preview: { width: W, height: H } })}'>
class Component extends DCLogic {
  renderVals() {
    return { theme: this.props.theme ?? '${theme}' };
  }
}
</script>
</body>
</html>
`;
const shell = (about, used, inner) => `<div class="shell" data-theme="{{theme}}" style="position:relative;height:${H}px;overflow:hidden;background:var(--bg);color:var(--fg);font-family:var(--font-body);font-size:var(--text-base);line-height:var(--leading-body)">
<!-- ${about} -->
${closeTags(sprite(used))}
${inner}
</div>`;

// ── the screens ─────────────────────────────────────────────────────────
const screens = [];
const src = fs.readFileSync(path.join(here, "screens/screens.html"), "utf8");
for (const m of src.matchAll(/<!--@screen ([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^>]*?)-->\n([\s\S]*?)<!--@endscreen-->/g)) {
  const [, id, area, name, state, theme, about, body] = m;
  if (!AREAS.some((a) => a.id === area)) throw new Error(`${id}: unknown area ${area}`);
  if (!THEMES.includes(theme)) throw new Error(`${id}: unknown theme ${theme}`);
  const file = `${id.replace("-", "")}-${name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("")}.dc.html`;
  const used = new Set();
  const root = shell(about, used, closeTags(expand(body, used)));
  screens.push({ id, area, name, state, theme, about, file, title: `${id} · ${name}`, root });
}
if (new Set(screens.map((s) => s.id)).size !== screens.length) throw new Error("duplicate screen id");

// ── the Index: Main.dc.html, every screen by area, each a link to its artboard ──
const indexUsed = new Set();
const indexBody = expand(`<div class="sheet" style="height:100%">
  <div class="wrap wrap-wide">
    <div class="sec-head"><div>
      <p class="eyebrow">Tomrade Screens</p>
      <h1 class="sec-title" style="font-size:var(--text-2xl);margin-top:var(--space-2)">Screen index</h1>
      <p class="sec-lede" style="margin-top:var(--space-2)">${screens.length} screens of the desktop app, drawn with the Tomrade Ledger design system. Each has an ID, an area page and a default theme; the Theme tweak shows it in any of the eight.</p>
    </div></div>
    <div style="display:grid;grid-template-columns:repeat(${AREAS.length},minmax(0,1fr));gap:var(--space-6);margin-top:var(--space-6)">
${AREAS.map((a) => {
  const list = screens.filter((s) => s.area === a.id);
  return `      <section>
        <div class="row-between" style="padding-bottom:var(--space-2)"><h2 style="font-size:var(--text-lg)">${a.name}</h2><span class="col-count num">${list.length}</span></div>
        <p class="meta-txt" style="margin-bottom:var(--space-3)">${a.about}</p>
${list.map((s) => `        <a class="rel-row" href="${s.file}" style="align-items:flex-start;text-decoration:none"><span class="card-id" style="padding-top:2px">${s.id}</span><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span style="color:var(--fg)">${s.name}</span><span class="meta-txt">${s.state}</span></span><span class="tag neutral">${s.theme}</span>[[i-chev 12 meta]]</a>`).join("\n")}
      </section>`;
}).join("\n")}
    </div>
    <hr class="rule">
    <p class="meta-txt dense" style="max-width:72ch">Source: <span class="num">scripts/design-system/screens/</span> in the tomrade repository. Shared parts (titlebar, sidebar, board, status bar, assistant) live once in <span class="num">parts.html</span>; <span class="num">pnpm design-system</span> rebuilds every screen, this index and the canvas layout.</p>
  </div>
</div>`, indexUsed);
const index = { file: "Main.dc.html", title: "Screen index", theme: "sunrise", root: shell("The index of every screen, by area.", indexUsed, closeTags(indexBody)) };

// ── write ───────────────────────────────────────────────────────────────
const proj = path.join(out, "canvas/project");
const prev = path.join(out, "canvas/preview");
fs.rmSync(path.join(out, "canvas"), { recursive: true, force: true });
fs.mkdirSync(path.join(proj, "ds/tomrade"), { recursive: true });
fs.mkdirSync(prev, { recursive: true });
fs.copyFileSync(path.join(out, "tokens.css"), path.join(proj, "ds/tomrade/tokens.css"));
for (const s of [index, ...screens]) {
  fs.writeFileSync(path.join(proj, s.file), dcFile(s));
  fs.writeFileSync(path.join(prev, s.file.replace(".dc.html", ".html")), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${s.title}</title><link rel="stylesheet" href="../../tokens.css"><link rel="stylesheet" href="../../project/components/bundle.css"><style>body{margin:0}</style></head><body>${s.root.replace("{{theme}}", s.theme)}</body></html>`);
}

// the layout: one page per area plus the Index; screens in ID order, left to right
const old = existingCanvas ? JSON.parse(fs.readFileSync(existingCanvas, "utf8")) : {};
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const pages = [{ id: "index", name: "Index" }, ...AREAS.map((a) => ({ id: a.id, name: a.name }))];
const boards = { "Main.dc.html": { x: 0, y: 0, w: W, h: H, title: index.title, page: "index", is_interactive: true } };
const notes = {
  "index-title": { x: 0, y: -300, text: "Tomrade Screens", kind: "title1", maxW: W, page: "index" },
  "index-howto": { x: W + GAP, y: 0, w: 440, size: "m", fill: "yellow", page: "index", text: "Every screen uses the app's own class names over the Tomrade Ledger design system (installed under ds/tomrade): tokens and component styles come from the system.\n\nChange a screen in scripts/design-system/screens/, a token or component in the design system, then rebuild with pnpm design-system and publish what changed.\n\nIDs: W workspace, H home, S settings. Add a screen by adding one @screen block." },
};
for (const a of AREAS) {
  const list = screens.filter((s) => s.area === a.id).sort((x, y) => x.id.localeCompare(y.id));
  list.forEach((s, i) => { boards[s.file] = { x: i * (W + GAP), y: 0, w: W, h: H, title: s.title, page: a.id, expand: "fill" }; });
  notes[`${a.id}-title`] = { x: 0, y: -300, text: a.name, kind: "title1", maxW: Math.max(W, list.length * (W + GAP) - GAP), page: a.id };
}
// notes another person added stay; ours are replaced
const keptNotes = Object.fromEntries(Object.entries(old.notes ?? {}).filter(([k]) => !/^(title|title2|howto)$/.test(k) && !notes[k] && !/-(title|howto)$/.test(k)));
const canvas = {
  ...old,
  v: 3,
  createdOnFiles: old.createdOnFiles ?? { v: 1, at: now },
  title: old.title ?? "Tomrade Screens",
  launch: { view: "canvas", page: "index" },
  pages,
  boards,
  order: Object.keys(boards),
  notes: { ...keptNotes, ...notes },
  designSystems: old.designSystems ?? [],
};
fs.writeFileSync(path.join(proj, "canvas.json"), JSON.stringify(canvas, null, 1) + "\n");
const removed = Object.keys(old.boards ?? {}).filter((f) => !boards[f]);
console.log(`${screens.length} screens + index → ${path.relative(process.cwd(), proj)}${removed.length ? `; no longer on the canvas: ${removed.join(", ")}` : ""}`);
