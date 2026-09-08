import { Context, type Plugin } from "cordis";
import { Db } from "@tomrade/db";
import { Hub } from "@tomrade/hub";
import { Oplog } from "@tomrade/oplog";
import { policy } from "@tomrade/write";
import { Fields } from "@tomrade/fields";
import { Items } from "@tomrade/items";
import { boards } from "@tomrade/boards";
import { Projects } from "@tomrade/projects";

export interface FreshOptions {
  /** Load the default write policy. Off, the guarantees it carries are gone — which is what the policy tests prove. */
  policy?: boolean;
  /** Extra plugins, loaded after the core in the order given; a tuple carries the plugin's config. */
  plugins?: (Plugin | [Plugin, unknown])[];
  /** A cache directory on disk instead of memory, for tests that reopen files. */
  cacheDir?: string;
  /** The Hub folder for tests that touch it; memory-only otherwise. */
  hubDir?: string;
  /** A pre-P0 single database to split on boot. */
  legacyPath?: string;
}

/** Nested fibers activate a microtask after their dependencies; this lets them. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fresh context with one project, its board and views seeded. */
export async function fresh(opts: FreshOptions = {}) {
  const ctx = new Context();
  const failures: unknown[] = [];
  ctx.logger.exporter({ export: (m) => { if (m.type === "error") failures.push(m.args[0]); } });

  await ctx.plugin(Db, { dir: opts.cacheDir ?? ":memory:" });
  await ctx.plugin(Hub, { memory: true, defaultDir: opts.hubDir });
  await ctx.plugin(Oplog);
  if (opts.policy !== false) await ctx.plugin(policy);
  await ctx.plugin(Fields);
  await ctx.plugin(Items);
  await ctx.plugin(boards);
  await ctx.plugin(Projects, { legacyPath: opts.legacyPath, backupsDir: opts.cacheDir ? `${opts.cacheDir}/backups` : undefined });
  for (const entry of opts.plugins ?? []) {
    const [plugin, config] = Array.isArray(entry) ? entry : [entry, undefined];
    await ctx.plugin(plugin as Plugin<unknown>, config);
  }
  await settle();
  if (failures.length) throw failures[0];

  const project = ctx.projects.list()[0]!;
  const board = ctx.boards.defaultFor(project.id);
  return {
    ctx,
    db: ctx.db.for(project.id),
    dbFor: (projectId: string) => ctx.db.for(projectId),
    hub: ctx.hub,
    oplog: ctx.oplog,
    items: ctx.items,
    fields: ctx.fields,
    boards: ctx.boards,
    views: ctx.views,
    projects: ctx.projects,
    project,
    board
  };
}
