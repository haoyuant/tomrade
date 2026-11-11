// Extracts the icon sprite from packages/ui/src/components/icons.tsx.
// usage: node build-icons.mjs <repoRoot> <dsOut>
//   <dsOut>/project/components/icons.svg      the sprite, verbatim geometry, currentColor kept
//   <dsOut>/icons/<id>.svg                     one file per symbol, ink fixed (for the asset browser)
//   <dsOut>/icons.json                         [{id, inner, viewBox}] for previews
import fs from "node:fs";
import path from "node:path";

const [repo, out] = process.argv.slice(2);
const src = fs.readFileSync(path.join(repo, "packages/ui/src/components/icons.tsx"), "utf8");
const kebab = { strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin", strokeDasharray: "stroke-dasharray", clipPath: "clip-path" };
const syms = [];
for (const line of src.split("\n")) {
  const m = /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*)<\/symbol>/.exec(line);
  if (!m) continue;
  let inner = m[3];
  // the <clipPath> element keeps its name; only the attribute becomes clip-path
  inner = inner.replace(/ (strokeWidth|strokeLinecap|strokeLinejoin|strokeDasharray|clipPath)=/g, (_, a) => ` ${kebab[a]}=`);
  if (/[{}]/.test(inner)) throw new Error("expression in " + m[1]);
  syms.push({ id: m[1], viewBox: m[2], inner });
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Tomrade icon sprite, generated from packages/ui/src/components/icons.tsx. Use: <svg width="14" height="14"><use href="icons.svg#i-plus"/></svg>. Ink is currentColor. -->\n` +
  syms.map((s) => `<symbol id="${s.id}" viewBox="${s.viewBox}">${s.inner}</symbol>`).join("\n") + "\n</svg>\n";
fs.mkdirSync(path.join(out, "project/components"), { recursive: true });
fs.writeFileSync(path.join(out, "project/components/icons.svg"), sprite);
fs.mkdirSync(path.join(out, "icons"), { recursive: true });
const INK = "#532f27", SURFACE = "#faf3e6"; // Dawn fg and surface
for (const s of syms) {
  const body = s.inner.replace(/currentColor/g, INK).replace(/var\(--surface\)/g, SURFACE);
  fs.writeFileSync(path.join(out, "icons", `${s.id}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="${s.viewBox}">${body}</svg>\n`);
}
fs.writeFileSync(path.join(out, "icons.json"), JSON.stringify(syms));
console.log(syms.length, "symbols");
