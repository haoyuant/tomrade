import { Context, Logger } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { ExtensionStore, Plugins, type PluginRow } from "@tomradex/plugins";
import { LOCK_FILE } from "@tomradex/plugin-kit";
import { applyPatches, forPlatform, interpolate, readConfig, readRows, resolvePlugin, writePatchRow, type PluginPatch } from "./loader.js";
import { fileExporter } from "./logfile.js";
import { nodeRuntime } from "./node-runtime.js";
import { errorMessage } from "@tomradex/contracts";

export interface BootOptions {
  configFile: string;
  /** Applied in order; a missing file is skipped. The first is where a switch thrown in the UI lands. */
  patchFiles?: string[];
  patches?: PluginPatch[][];
  vars: Record<string, string>;
  /**
   * Where installed extensions live, and whose attestations to believe. Absent: no extension store.
   * `appVersion` is what a full-mode plugin's `engines.tomrade` is held to; a checkout passes none.
   */
  extensions?: { root: string; trustedKeys: Record<string, string>; appVersion?: string | null };
  /** The caller opens a window and emits `app/started` once it has loaded; otherwise boot does as it returns. */
  windowComing?: boolean;
}

export interface Booted {
  ctx: Context;
  rows: PluginRow[];
  dump(): string;
}

function consoleExporter() {
  return {
    colors: 0,
    export(message: Parameters<typeof Logger.format>[1]) {
      const line = `[${message.name}] ${Logger.format(this, message)}`;
      if (message.type === "error") console.error(line);
      else if (message.type === "warn") console.warn(line);
      else console.log(line);
    }
  };
}

/** The composition could not be read — a patch file, a variable, the extension lock. Nothing has started, so another boot in this process is safe. */
export class ConfigUnreadable extends Error {
  override name = "ConfigUnreadable";
}

/**
 * Everything read before a plugin starts — the person's patch files and extension lock among it.
 * Rows are laid on in order: the app's, then full-mode extensions' in the order they were
 * installed, then the person's patch files, so the person's own word is the last.
 */
function compose(opts: BootOptions, vars: Record<string, string>) {
  const { rows: base, modules, contracts } = readConfig(opts.configFile);
  const fromFiles = (opts.patchFiles ?? []).filter((f) => fs.existsSync(f)).map(readRows);
  const extensions = opts.extensions
    ? new ExtensionStore({ root: opts.extensions.root, lockFile: path.join(opts.extensions.root, LOCK_FILE), trustedKeys: opts.extensions.trustedKeys, importer: (url) => import(url), appVersion: opts.extensions.appVersion ?? null })
    : undefined;
  // An extension's rows that name a variable this start does not have are its problem, not the start's.
  const dropped: string[] = [];
  const fromPackages = (extensions?.patches(base.map((r) => r.id)) ?? []).filter((p) => {
    try {
      interpolate(p.rows, vars);
      return true;
    } catch (error) {
      dropped.push(`${p.from}: its rows were not applied — ${errorMessage(error)}`);
      return false;
    }
  });
  const recompose = (without: ReadonlySet<string>) =>
    interpolate(forPlatform(applyPatches(base, [...fromPackages.filter((p) => !without.has(p.from)).map((p) => p.rows), ...fromFiles, ...(opts.patches ?? [])])), vars);
  const rows = recompose(new Set());
  // applyPatches drops the switch of a row the app stopped shipping; a plugin that takes that row's place still reads it.
  const leftSwitches = Object.fromEntries(fromFiles.flat().flatMap((r) => (typeof r.disabled === "boolean" && !rows.some((row) => row.id === r.id) ? [[r.id, r.disabled]] : [])));
  return { rows, modules, contracts, extensions, recompose, rowsFrom: fromPackages.map((p) => p.from), dropped, leftSwitches };
}

/**
 * Create the context and hand the composition to `ctx.plugins`, which loads
 * every row, waits until nothing is still loading, and stays around as the
 * thing that can switch a row off again.
 */
export async function boot(opts: BootOptions): Promise<Booted> {
  const ctx = new Context();
  ctx.logger.exporter(consoleExporter());

  const baseDir = path.dirname(opts.configFile);
  // A run that names no Hub or plugin folders keeps them beside its own data,
  // so a check never seeds projects into the person's ~/Tomrade; nor, unless it
  // says so, does it write itself into their agents' own configuration.
  const own = opts.vars.userData ?? baseDir;
  const vars = { appDir: baseDir, hubDir: path.join(own, "hub"), pluginsRoot: path.join(own, "plugins"), pluginsDevRoot: path.join(own, "plugins-dev"), logDir: path.join(own, "logs"), appVersion: "dev", locale: "en", instanceKind: "dev", mcpPort: "19090", linkAgents: "false", nodeRuntime: nodeRuntime(), userData: own, machineData: own, uiPages: pathToFileURL(path.join(baseDir, "../../packages/ui/dist/")).href, ...opts.vars };
  // Before any file is read, so a start that fails on one leaves the reason in the log.
  ctx.logger.exporter(fileExporter(vars.logDir));
  let composition: ReturnType<typeof compose>;
  try {
    composition = compose(opts, vars);
  } catch (error) {
    ctx.logger("boot").error(error);
    throw new ConfigUnreadable(errorMessage(error), { cause: error });
  }
  const { rows, modules, contracts, extensions, recompose, rowsFrom, dropped, leftSwitches } = composition;
  for (const reason of dropped) ctx.logger("boot").warn(reason);
  // A promise nobody waited on would otherwise leave no trace in a packaged build.
  const unhandled = (reason: unknown) => ctx.logger("process").error(reason);
  process.on("unhandledRejection", unhandled);
  // The user's own patch file, which is the first: a --patch passed on the
  // command line describes one run and is never written back.
  const patchFile = opts.patchFiles?.[0];
  const extensionsRoot = opts.extensions?.root ?? vars.pluginsRoot;

  await ctx.plugin(Plugins, {
    rows,
    modules,
    contracts,
    extensions,
    resolve: (row) => resolvePlugin(row, baseDir, extensionsRoot),
    persist: patchFile ? (id, disabled) => writePatchRow(patchFile, id, { disabled }) : undefined,
    recompose,
    rowsFrom,
    leftSwitches
  });
  if (!opts.windowComing) ctx.emit("app/started");

  return { ctx, rows, dump: () => stringify(ctx.plugins.snapshot()) };
}
