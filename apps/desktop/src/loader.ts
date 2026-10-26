import type { Plugin } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Document, isMap, isSeq, parse, parseDocument } from "yaml";
import { adaptSdkPlugin, builtinIdentity, identityOf } from "@tomradex/extensions";
import { dataDirFor } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, isSdkPlugin, parseManifest } from "@tomradex/plugin-sdk";
import type { ContractSpec, ModuleSpec, PluginRow } from "@tomradex/plugins";
import { errorMessage } from "@tomradex/contracts";

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

function contractsOf(raw: unknown, file: string): ContractSpec[] {
  const contracts = isRecord(raw) ? raw.contracts : undefined;
  if (contracts === undefined) return [];
  if (!Array.isArray(contracts)) throw new Error(`${file}: expected "contracts" to be a list`);
  return contracts.map((contract, i) => {
    if (!isRecord(contract) || typeof contract.id !== "string" || typeof contract.title !== "string" || typeof contract.registry !== "string") {
      throw new Error(`${file}: contracts[${i}] needs a string id, title and registry`);
    }
    return { id: contract.id, title: contract.title, registry: contract.registry };
  });
}

/** YAML's own errors name a line but not the file, which is what the person has to open. */
function parseFile(file: string): unknown {
  const text = fs.readFileSync(file, "utf8");
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`, { cause: error });
  }
}

/** The whole composition: the rows to load, the capabilities they may not leave unfilled, and the registries they plug into. */
export function readConfig(file: string): { rows: PluginPatch[]; modules: ModuleSpec[]; contracts: ContractSpec[] } {
  const raw = parseFile(file);
  const rows = rowsOf(raw, file);
  // Rows are keyed by id, so a second row with the same id would silently replace the first.
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${file}: two plugin rows share the id "${row.id}"`);
    seen.add(row.id);
  }
  return { rows, modules: modulesOf(raw, file), contracts: contractsOf(raw, file) };
}

export function readRows(file: string): PluginPatch[] {
  return rowsOf(parseFile(file), file);
}

/** A patch row replaces the fields it names on the row with the same id; an unknown id adds a row. */
export function applyPatches(base: PluginPatch[], patches: PluginPatch[][]): PluginRow[] {
  const rows = new Map(base.map((r) => [r.id, { ...r }]));
  for (const patch of patches) {
    for (const row of patch) {
      // A switch left behind for a plugin the app no longer ships.
      if (!rows.has(row.id) && typeof row.name !== "string") continue;
      const merged = { ...rows.get(row.id), ...row };
      // A plugin named by a later layer is that layer's, not the extension's whose rows named one before.
      if (row.name !== undefined && row.from === undefined) delete merged.from;
      rows.set(row.id, merged);
    }
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

/** The rows this platform loads: one naming other platforms is left out, as if it were not written. */
export function forPlatform<T extends Pick<PluginRow, "platforms">>(rows: T[], platform: string = process.platform): T[] {
  return rows.filter((r) => !Array.isArray(r.platforms) || r.platforms.includes(platform));
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
