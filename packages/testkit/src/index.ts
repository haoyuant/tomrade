import { Context, type Plugin } from "cordis";
import { Db } from "@tomrade/db";
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
  dbPath?: string;
}

/** Nested fibers activate a microtask after their dependencies; this lets them. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fresh context with the default project, its board and views seeded. */
export async function fresh(opts: FreshOptions = {}) {
  const ctx = new Context();
  const failures: unknown[] = [];
  ctx.logger.exporter({ export: (m) => { if (m.type === "error") failures.push(m.args[0]); } });

  await ctx.plugin(Db, { path: opts.dbPath ?? ":memory:" });
  await ctx.plugin(Oplog);
  if (opts.policy !== false) await ctx.plugin(policy);
  await ctx.plugin(Fields);
  await ctx.plugin(Items);
  await ctx.plugin(boards);
  await ctx.plugin(Projects);
  for (const entry of opts.plugins ?? []) {
    const [plugin, config] = Array.isArray(entry) ? entry : [entry, undefined];
    await ctx.plugin(plugin as Plugin<unknown>, config);
  }
  await settle();
  if (failures.length) throw failures[0];

  // 'default' is a first-run seed, not a guarantee: a database whose default
  // project was deleted opens on whatever project it does have.
  const project = (ctx.projects.get("default") ?? ctx.projects.list()[0])!;
  const board = ctx.boards.defaultFor(project.id);
  return { ctx, db: ctx.db, oplog: ctx.oplog, items: ctx.items, fields: ctx.fields, boards: ctx.boards, views: ctx.views, projects: ctx.projects, project, board };
}
