import { Context, Logger } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { ExtensionStore, Plugins, type PluginRow } from "@tomradex/plugins";
import { LOCK_FILE } from "@tomradex/plugin-kit";
import { applyPatches, interpolate, readConfig, readRows, resolvePlugin, writePatchRow, type PluginPatch } from "./loader.js";
import { fileExporter } from "./logfile.js";

export interface BootOptions {
  configFile: string;
  /** Applied in order; a missing file is skipped. The first is where a switch thrown in the UI lands. */
  patchFiles?: string[];
  patches?: PluginPatch[][];
  vars: Record<string, string>;
  /** Where installed extensions live, and whose attestations to believe. Absent: no extension store. */
  extensions?: { root: string; trustedKeys: Record<string, string> };
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

/**
 * Create the context and hand the composition to `ctx.plugins`, which loads
 * every row, waits until nothing is still loading, and stays around as the
 * thing that can switch a row off again.
 */
export async function boot(opts: BootOptions): Promise<Booted> {
  const ctx = new Context();
  ctx.logger.exporter(consoleExporter());

  const { rows: base, modules, contracts } = readConfig(opts.configFile);
  const fromFiles = (opts.patchFiles ?? []).filter((f) => fs.existsSync(f)).map(readRows);
  const baseDir = path.dirname(opts.configFile);
  // A run that names no Hub or plugin folders keeps them beside its own data,
  // so a check never seeds projects into the person's ~/Tomrade.
  const own = opts.vars.userData ?? baseDir;
  const vars = { appDir: baseDir, hubDir: path.join(own, "hub"), pluginsRoot: path.join(own, "plugins"), pluginsDevRoot: path.join(own, "plugins-dev"), logDir: path.join(own, "logs"), appVersion: "dev", locale: "en", instanceKind: "dev", mcpPort: "19090", userData: own, ...opts.vars };
  ctx.logger.exporter(fileExporter(vars.logDir));
  // A promise nobody waited on would otherwise leave no trace in a packaged build.
  const unhandled = (reason: unknown) => ctx.logger("process").error(reason);
  process.on("unhandledRejection", unhandled);
  const rows = interpolate(applyPatches(base, [...fromFiles, ...(opts.patches ?? [])]), vars);
  // The user's own patch file, which is the first: a --patch passed on the
  // command line describes one run and is never written back.
  const patchFile = opts.patchFiles?.[0];

  const extensionsRoot = opts.extensions?.root ?? vars.pluginsRoot;
  const extensions = opts.extensions
    ? new ExtensionStore({ root: opts.extensions.root, lockFile: path.join(opts.extensions.root, LOCK_FILE), trustedKeys: opts.extensions.trustedKeys, importer: (url) => import(url) })
    : undefined;

  await ctx.plugin(Plugins, {
    rows,
    modules,
    contracts,
    extensions,
    resolve: (row) => resolvePlugin(row, baseDir, extensionsRoot),
    persist: patchFile ? (id, disabled) => writePatchRow(patchFile, id, { disabled }) : undefined
  });

  return { ctx, rows, dump: () => stringify(ctx.plugins.snapshot()) };
}
