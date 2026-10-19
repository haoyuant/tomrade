import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { satisfies, type Manifest } from "@tomradex/plugin-sdk";
import { importsOf } from "./sdk-imports.js";

/** What each of Tomrade's own packages exports, by import specifier, for one Tomrade version. */
export interface AppExports {
  /** null for a checkout, which, like the app run from one, holds a plugin to no range. */
  tomrade: string | null;
  modules: Record<string, string[]>;
}

export const APP_EXPORTS_FILE = "app-exports.json";

/** Packages a plugin reaches some other way: the SDK line (bundled or shared) and the renderer. */
const NOT_APP = new Set(["@tomradex/plugin-sdk", "@tomradex/ui"]);

/** The app's packages in a checkout, each import specifier with the file it loads. */
function appEntries(root: string): { specifier: string; file: string }[] {
  const out: { specifier: string; file: string }[] = [];
  for (const dir of fs.readdirSync(path.join(root, "packages"))) {
    const manifest = path.join(root, "packages", dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; exports?: Record<string, string | { default?: string }> };
    if (!pkg.name?.startsWith("@tomradex/") || NOT_APP.has(pkg.name)) continue;
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      const file = typeof target === "string" ? target : target.default;
      if (file) out.push({ specifier: sub === "." ? pkg.name : `${pkg.name}/${sub.slice(2)}`, file: path.join(root, "packages", dir, file) });
    }
  }
  return out;
}

/** Reads what each built package of a checkout exports, as `tomrade` (a release's version, or null); one that cannot load outside the app is left out. */
export async function collectAppExports(root: string, tomrade: string | null): Promise<AppExports> {
  const modules: Record<string, string[]> = {};
  for (const { specifier, file } of appEntries(root)) {
    if (!fs.existsSync(file)) continue;
    try {
      modules[specifier] = Object.keys(await import(pathToFileURL(file).href)).sort();
    } catch {
      // a module that needs Electron or the app around it; its imports go unchecked
    }
  }
  return { tomrade, modules };
}

let known: Promise<AppExports | null> | null = null;

/** The exports of the Tomrade this CLI came with: the file shipped beside it, else the checkout it runs from. */
export function appExports(): Promise<AppExports | null> {
  known ??= (async () => {
    const shipped = new URL(`./${APP_EXPORTS_FILE}`, import.meta.url);
    if (fs.existsSync(shipped)) return JSON.parse(fs.readFileSync(shipped, "utf8")) as AppExports;
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) && fs.existsSync(path.join(dir, "apps/desktop/package.json"))) return collectAppExports(dir, null);
    }
    return null;
  })();
  return known;
}

/**
 * Tomrade's own packages are the running app's copies, so a full-mode plugin may
 * take only what the Tomrade it names has; an SDK plugin gets none of them.
 */
export function appImportProblems(file: string, manifest: Pick<Manifest, "context" | "engines">, app: AppExports | null): { problems: string[]; notes: string[] } {
  const out = { problems: [] as string[], notes: [] as string[] };
  if (!fs.existsSync(file)) return out;
  const imports = importsOf(fs.readFileSync(file, "utf8"), (s) => s.startsWith("@tomradex/") && !NOT_APP.has(s) && s !== "@tomradex/domain");
  const specifiers = Object.keys(imports).sort();
  if (!specifiers.length) return out;
  if (manifest.context !== "full") {
    for (const s of specifiers) out.problems.push(`imports ${s}, which only a full-mode plugin gets ("context": "full"); an SDK plugin runs against @tomradex/plugin-sdk alone`);
    return out;
  }
  if (!app) {
    out.notes.push(`imports ${specifiers.join(", ")}; this CLI knows no Tomrade to check them against`);
    return out;
  }
  if (app.tomrade !== null && !satisfies(app.tomrade, manifest.engines.tomrade ?? "")) {
    out.notes.push(`imports ${specifiers.join(", ")}; this CLI knows Tomrade ${app.tomrade}, outside engines.tomrade "${manifest.engines.tomrade}", so they were not checked`);
    return out;
  }
  const which = app.tomrade === null ? "this Tomrade checkout" : `Tomrade ${app.tomrade}`;
  for (const s of specifiers) {
    const has = app.modules[s];
    if (!has) {
      out.problems.push(`imports ${s}, which ${which} does not have`);
      continue;
    }
    const { names, namespace } = imports[s]!;
    if (namespace) out.notes.push(`takes ${s} as a whole module, so which of its names exist cannot be checked`);
    for (const name of names) if (!has.includes(name)) out.problems.push(`imports "${name}" from ${s}, which ${which} does not export`);
  }
  return out;
}
