import fs from "node:fs";
import path from "node:path";
import { Context, Logger, type Fiber } from "cordis";
import { applyPatches, describeRow, dumpRows, interpolate, readRows, resolvePlugin, type PluginPatch, type PluginRow } from "./loader.js";

export interface BootOptions {
  configFile: string;
  /** Applied in order; a missing file is skipped. */
  patchFiles?: string[];
  patches?: PluginPatch[][];
  vars: Record<string, string>;
}

export interface Booted {
  ctx: Context;
  rows: PluginRow[];
  dump(): string;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

/** Create the context, load every row, and wait until nothing is still loading. */
export async function boot(opts: BootOptions): Promise<Booted> {
  const ctx = new Context();
  ctx.logger.exporter(consoleExporter());

  const fromFiles = (opts.patchFiles ?? []).filter((f) => fs.existsSync(f)).map(readRows);
  const rows = interpolate(applyPatches(readRows(opts.configFile), [...fromFiles, ...(opts.patches ?? [])]), opts.vars);
  const baseDir = path.dirname(opts.configFile);

  const fibers = new Map<string, Fiber>();
  const errors = new Map<string, unknown>();
  for (const row of rows) {
    if (row.disabled) continue;
    try {
      fibers.set(row.id, ctx.plugin(await resolvePlugin(row.name, baseDir), row.config));
    } catch (error) {
      errors.set(row.id, error);
      ctx.logger.error(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A fiber whose dependencies arrive later starts loading after the notify
  // that brings them, so settle until no fiber is mid-flight.
  let loading = true;
  while (loading) {
    for (const [id, fiber] of fibers) {
      try {
        await fiber;
      } catch (error) {
        errors.set(id, error);
      }
    }
    await tick();
    loading = [...fibers.values()].some((f) => f.state === 1 || f.state === 5);
  }

  const has = (name: string) => ctx.get(name) !== undefined;
  const described = () => rows.map((row) => describeRow(row, fibers.get(row.id), errors.get(row.id), has));
  for (const row of described()) {
    if (row.state === "pending") ctx.logger.warn(`${row.id} is waiting for: ${row.waitingFor?.join(", ") ?? "?"}`);
  }
  return { ctx, rows, dump: () => dumpRows(described()) };
}
