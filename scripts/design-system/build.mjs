// Rebuilds the Tomrade Ledger design system's files into out/design-system.
// Reads packages/ui only; never writes inside the repository's sources.
// usage: pnpm design-system   (or: node scripts/design-system/build.mjs [outDir])
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(repo, "out/design-system"));
fs.mkdirSync(out, { recursive: true });

const run = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), ...args], { stdio: "inherit" });
run("build-icons.mjs", repo, out); // the sprite first: the Icon card is drawn from it
run("build-ds.mjs", repo, out);
run("build-components.mjs", out);
// the screens canvas; pass the canvas's current canvas.json in CANVAS_JSON to keep its other keys and notes
run("build-screens.mjs", out, ...(process.env.CANVAS_JSON ? [process.env.CANVAS_JSON] : []));

const rel = path.relative(process.cwd(), out) || ".";
console.log(`\nDesign system in ${rel}/project, screens canvas in ${rel}/canvas/project — publish only what changed (see scripts/design-system/README.md).`);
