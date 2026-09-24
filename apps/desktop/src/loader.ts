import type { Plugin } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Document, isMap, isSeq, parse, parseDocument } from "yaml";
import { adaptSdkPlugin, builtinIdentity, identityOf } from "@tomrade/extensions";
import { dataDirFor } from "@tomrade/plugin-kit";
import { MANIFEST_FILE, isSdkPlugin, parseManifest } from "@tomrade/plugin-sdk";
import type { ModuleSpec, PluginRow } from "@tomrade/plugins";

export type { PluginRow };

export type PluginPatch = Partial<PluginRow> & { id: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rowsOf(raw: unknown, file: string): PluginPatch[] {
  const plugins = isRecord(raw) ? raw.plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error(`${file}: expected a top-level "plugins" list`);
  return plugins.map((row, i) => {
    if (!isRecord(row) || typeof row.id !== "string") throw new Error(`${file}: plugins[${i}] needs a string id`);
    return row as PluginPatch;
  });
}

function modulesOf(raw: unknown, file: string): ModuleSpec[] {
  const modules = isRecord(raw) ? raw.modules : undefined;
  if (modules === undefined) return [];
  if (!Array.isArray(modules)) throw new Error(`${file}: expected "modules" to be a list`);
  return modules.map((module, i) => {
    if (!isRecord(module) || typeof module.id !== "string" || typeof module.title !== "string") {
      throw new Error(`${file}: modules[${i}] needs a string id and title`);
    }
    return { id: module.id, title: module.title, required: module.required === true };
  });
}

/** The whole composition: the rows to load, and the capabilities they may not leave unfilled. */
export function readConfig(file: string): { rows: PluginPatch[]; modules: ModuleSpec[] } {
  const raw: unknown = parse(fs.readFileSync(file, "utf8"));
  return { rows: rowsOf(raw, file), modules: modulesOf(raw, file) };
}

export function readRows(file: string): PluginPatch[] {
  return rowsOf(parse(fs.readFileSync(file, "utf8")), file);
}

/** A patch row replaces the fields it names on the row with the same id; an unknown id adds a row. */
export function applyPatches(base: PluginPatch[], patches: PluginPatch[][]): PluginRow[] {
  const rows = new Map(base.map((r) => [r.id, { ...r }]));
  for (const patch of patches) {
    for (const row of patch) rows.set(row.id, { ...rows.get(row.id), ...row });
  }
  return [...rows.values()].map((r, i) => {
    if (typeof r.name !== "string") throw new Error(`plugins[${i}] "${r.id}" has no plugin name`);
    return r as PluginRow;
  });
}

/**
 * Write one row's fields back to a patch file, in place. The file is edited as
 * a document rather than re-serialised, so rows and comments the user put there
 * by hand survive a switch thrown in the UI.
 */
export function writePatchRow(file: string, id: string, fields: Partial<PluginRow>): void {
  const doc = fs.existsSync(file) ? parseDocument(fs.readFileSync(file, "utf8")) : new Document({ plugins: [] });
  const rows = doc.get("plugins");
  if (!isSeq(rows)) throw new Error(`${file}: expected a top-level "plugins" list`);
  const row = rows.items.find((item) => isMap(item) && item.get("id") === id);
  if (isMap(row)) for (const [key, value] of Object.entries(fields)) row.set(key, value);
  else rows.add(doc.createNode({ id, ...fields }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(doc), "utf8");
}

/** Static `${var}` substitution in config strings — never evaluation. */
export function interpolate<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, key: string) => {
      if (!(key in vars)) throw new Error(`unknown config variable \${${key}}`);
      return vars[key];
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)])) as T;
  return value;
}

/** The nearest directory above a module file that is a package: where its own files live. */
function packageRootOf(file: string): string | null {
  let dir = path.dirname(file);
  while (true) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE)) || fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * A bare name is a package; anything path-like is resolved against the config
 * file's directory. A row written with the plugin SDK is loaded behind the
 * extension host: as an extension when its package carries a manifest, as
 * part of the app otherwise.
 */
export async function resolvePlugin(row: Pick<PluginRow, "id" | "name">, baseDir: string, pluginsRoot: string): Promise<Plugin> {
  const name = row.name;
  const isPath = name.startsWith(".") || path.isAbsolute(name);
  const file = isPath ? path.resolve(baseDir, name) : fileURLToPath(import.meta.resolve(name));
  const mod = (await import(isPath ? pathToFileURL(file).href : name)) as Record<string, unknown>;
  const candidate: unknown = mod.default ?? mod;
  if (isSdkPlugin(candidate)) {
    const root = packageRootOf(file);
    const manifestFile = root ? path.join(root, MANIFEST_FILE) : null;
    if (root && manifestFile && fs.existsSync(manifestFile)) {
      const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
      const dataDir = dataDirFor(pluginsRoot, manifest.id);
      fs.mkdirSync(dataDir, { recursive: true });
      return adaptSdkPlugin(candidate, identityOf(manifest, { root, dataDir }));
    }
    return adaptSdkPlugin(candidate, builtinIdentity(row.id, root));
  }
  if (typeof candidate !== "function" && !(isRecord(candidate) && typeof candidate.apply === "function")) {
    throw new Error(`${name} does not export a plugin (a function, a class, or an object with apply())`);
  }
  return candidate as Plugin;
}
