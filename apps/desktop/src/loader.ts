import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import type { Fiber, Plugin } from "cordis";

export interface PluginRow {
  id: string;
  name: string;
  config?: unknown;
  disabled?: boolean;
}

export type PluginPatch = Partial<PluginRow> & { id: string };

interface ConfigFile {
  plugins?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rowsOf(raw: unknown, file: string): PluginPatch[] {
  const plugins = isRecord(raw) ? (raw as ConfigFile).plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error(`${file}: expected a top-level "plugins" list`);
  return plugins.map((row, i) => {
    if (!isRecord(row) || typeof row.id !== "string") throw new Error(`${file}: plugins[${i}] needs a string id`);
    return row as PluginPatch;
  });
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

/** A bare name is a package; anything path-like is resolved against the config file's directory. */
export async function resolvePlugin(name: string, baseDir: string): Promise<Plugin> {
  const isPath = name.startsWith(".") || path.isAbsolute(name);
  const specifier = isPath ? pathToFileURL(path.resolve(baseDir, name)).href : name;
  const mod = (await import(specifier)) as Record<string, unknown>;
  const candidate: unknown = mod.default ?? mod;
  if (typeof candidate !== "function" && !(isRecord(candidate) && typeof candidate.apply === "function")) {
    throw new Error(`${name} does not export a plugin (a function, a class, or an object with apply())`);
  }
  return candidate as Plugin;
}

export interface BootedRow extends PluginRow {
  state: "active" | "failed" | "pending" | "disabled";
  error?: string;
  /** For a pending row: the services it is still waiting for. */
  waitingFor?: string[];
}

const STATE: Record<number, BootedRow["state"]> = { 0: "pending", 1: "pending", 2: "active", 3: "failed", 4: "failed", 5: "pending" };

export function describeRow(row: PluginRow, fiber: Fiber | undefined, error: unknown, has: (name: string) => boolean): BootedRow {
  if (row.disabled) return { ...row, state: "disabled" };
  if (error || !fiber) return { ...row, state: "failed", error: error instanceof Error ? error.message : String(error ?? "not loaded") };
  const state = STATE[fiber.state] ?? "pending";
  const waitingFor = state === "pending" ? Object.keys(fiber.inject).filter((name) => !has(name)) : undefined;
  return { ...row, state, ...(waitingFor?.length ? { waitingFor } : {}) };
}

export const dumpRows = (rows: BootedRow[]): string => stringify({ plugins: rows });
