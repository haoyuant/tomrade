import { Context, type Plugin } from "cordis";
import { Db } from "@tomradex/db";
import { Hub } from "@tomradex/hub";
import { Oplog } from "@tomradex/oplog";
import { policy } from "@tomradex/write";
import { Fields } from "@tomradex/fields";
import { Items } from "@tomradex/items";
import { boards } from "@tomradex/boards";
import { Projects } from "@tomradex/projects";
import { adaptSdkPlugin, builtinIdentity, type ExtensionIdentity } from "@tomradex/extensions";
import { isSdkPlugin, type SdkPlugin } from "@tomradex/plugin-sdk";

/** An SDK plugin as a loadable row. An `origin: "extension"` identity holds it to its namespace. */
export const sdk = (plugin: SdkPlugin<unknown>, identity: Partial<ExtensionIdentity> & { id: string }): Plugin =>
  adaptSdkPlugin(plugin, { ...builtinIdentity(identity.id), ...identity });

export interface FreshOptions {
  /** Load the default write policy. Off, the guarantees it carries are gone — which is what the policy tests prove. */
  policy?: boolean;
  /** Extra plugins, loaded after the core in the order given; a tuple carries the plugin's config. */
  plugins?: (Plugin | SdkPlugin<unknown> | [Plugin | SdkPlugin<unknown>, unknown])[];
  /** A cache directory on disk instead of memory, for tests that reopen files. */
  cacheDir?: string;
  /** The Hub folder for tests that touch it; memory-only otherwise. */
  hubDir?: string;
  /** A pre-P0 single database to split on boot. */
  legacyPath?: string;
  /** "none" leaves the first project to a plugin in `plugins`, as the app leaves it to onboarding. */
  firstRun?: "default" | "none";
  /** This machine's device id, for tests that play two machines sharing a project; "test-device" otherwise. */
  device?: string;
}

/** Nested fibers activate a microtask after their dependencies; this lets them. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A test's time limit for work that starts processes: as given elsewhere, three times it on Windows, which starts a
 * process an order slower (git: 30-36 ms a call against a few on macOS). For a test or suite that sets its own limit;
 * vitest.config.ts raises the global one there.
 */
export const spawnBudget = (ms: number): number => (process.platform === "win32" ? ms * 3 : ms);

/** The contexts `fresh` booted, held weakly: a file that never disposes them keeps none alive. */
const booted = new Set<WeakRef<Context>>();

/**
 * Disposes every context `fresh` booted, closing the database files they hold: before a test file removes its folder,
 * since Windows will not delete a file that is still open.
 */
export async function disposeFresh(): Promise<void> {
  for (const ref of [...booted]) {
    booted.delete(ref);
    await ref.deref()?.fiber.dispose();
  }
}

/** A fresh context with one project, its board and views seeded. */
export async function fresh(opts: FreshOptions = {}) {
  const ctx = new Context();
  booted.add(new WeakRef(ctx));
  const failures: unknown[] = [];
  ctx.logger.exporter({ export: (m) => { if (m.type === "error") failures.push(m.args[0]); } });

  await ctx.plugin(Db, { dir: opts.cacheDir ?? ":memory:" });
  await ctx.plugin(Hub, { memory: true, defaultDir: opts.hubDir, device: opts.device });
  await ctx.plugin(Oplog);
  if (opts.policy !== false) await ctx.plugin(policy);
  await ctx.plugin(Fields);
  await ctx.plugin(Items);
  await ctx.plugin(boards);
  await ctx.plugin(Projects, { legacyPath: opts.legacyPath, backupsDir: opts.cacheDir ? `${opts.cacheDir}/backups` : undefined, firstRun: opts.firstRun });
  for (const [i, entry] of (opts.plugins ?? []).entries()) {
    const [plugin, config] = Array.isArray(entry) ? entry : [entry, undefined];
    await ctx.plugin((isSdkPlugin(plugin) ? sdk(plugin, { id: `sdk-${i}` }) : plugin) as Plugin<unknown>, config);
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

export { FakeHerdr, type FakeHerdrCall, type FakePane } from "./herdr.js";
export { FakeGh, type FakeGhReply } from "./gh.js";
