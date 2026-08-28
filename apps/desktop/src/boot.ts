import { Context, Logger } from "cordis";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { Plugins, type PluginRow } from "@tomrade/plugins";
import { applyPatches, interpolate, readConfig, readRows, resolvePlugin, writePatchRow, type PluginPatch } from "./loader.js";

export interface BootOptions {
  configFile: string;
  /** Applied in order; a missing file is skipped. The first is where a switch thrown in the UI lands. */
  patchFiles?: string[];
  patches?: PluginPatch[][];
  vars: Record<string, string>;
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

  const { rows: base, modules } = readConfig(opts.configFile);
  const fromFiles = (opts.patchFiles ?? []).filter((f) => fs.existsSync(f)).map(readRows);
  const rows = interpolate(applyPatches(base, [...fromFiles, ...(opts.patches ?? [])]), opts.vars);
  const baseDir = path.dirname(opts.configFile);
  // The user's own patch file, which is the first: a --patch passed on the
  // command line describes one run and is never written back.
  const patchFile = opts.patchFiles?.[0];

  await ctx.plugin(Plugins, {
    rows,
    modules,
    resolve: (name) => resolvePlugin(name, baseDir),
    persist: patchFile ? (id, disabled) => writePatchRow(patchFile, id, { disabled }) : undefined
  });

  return { ctx, rows, dump: () => stringify(ctx.plugins.snapshot()) };
}
