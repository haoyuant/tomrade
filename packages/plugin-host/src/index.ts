import path from "node:path";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Contributions } from "@tomradex/contributions";

export interface TestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HostTestResult {
  ok: boolean;
  checks: TestCheck[];
  logs: string[];
}

export interface HostTestInput {
  /** The plugin's default export, already loaded. */
  plugin: { config?: { safeParse(v: unknown): { success: boolean; data?: unknown } }; apply(ctx: unknown, config: unknown): unknown };
  id: string;
  namespace: string;
  dir: string;
  /** A directory the plugin may write: its data dir and the throwaway settings file go here. */
  tmp: string;
  /** Loads the plugin's scenario module the same way the plugin itself was loaded. */
  scenario: (() => Promise<Record<string, unknown>>) | null;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const timeout = (ms: number, what: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms));

const configOf = (p: HostTestInput["plugin"]) => {
  const parsed = p.config?.safeParse(undefined);
  return parsed?.success ? parsed.data : undefined;
};

/**
 * Loads a plugin into a fresh project with three sample issues, runs every
 * contribution it made once, then its scenario if it has one. Kept apart from
 * the plugin CLI so the CLI carries no Tomrade code of its own.
 */
export async function testPlugin(input: HostTestInput): Promise<HostTestResult> {
  const checks: TestCheck[] = [];
  const logs: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const p = input.plugin;
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(input.tmp, "settings.json") }], Contributions] });
  w.ctx.logger.exporter({ export: (m: { type: string; args: unknown[] }) => void (m.type === "error" || m.type === "warn" ? logs.push(`${m.type}: ${String(m.args[0])}`) : undefined) } as never);
  const samples = [
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "A sample issue", by: "human" }),
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Another in progress", status: "doing", by: "human" }),
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "One that is done", status: "done", by: "human" })
  ];
  const before = new Set(w.ctx.tools.list().map((t) => t.name));
  const fiber = w.ctx.plugin(sdk(p as never, { id: input.id, namespace: input.namespace, origin: "extension", root: input.dir, dataDir: input.tmp }), configOf(p));
  try {
    await Promise.race([fiber, timeout(5_000, "loading the plugin")]);
    await settle();
  } catch (error) {
    check("loads", false, messageOf(error));
    return { ok: false, checks, logs };
  }
  check("loads", fiber.state === 2 && !logs.some((l) => l.startsWith("error")), logs.find((l) => l.startsWith("error")));

  const scope = { projectId: w.project.id };
  const guarded = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await Promise.race([fn(), timeout(3_000, name)]);
      check(name, true);
    } catch (error) {
      check(name, false, messageOf(error));
    }
  };
  const before_ = logs.length;
  await guarded("badges compute", () => w.ctx.contributions.badgesFor(w.project.id));
  await guarded("status items compute", () => w.ctx.contributions.statusItems(scope));
  await guarded("sections render", () => w.ctx.contributions.sectionsFor(w.project.id, samples[0]!.id));
  await guarded("assistant widgets compute", () => w.ctx.contributions.assistantWidgets());
  await guarded("sidebar modules compute", () => w.ctx.contributions.sidebarModules(w.project.id));
  for (const g of w.ctx.contributions.graphs()) await guarded(`graph ${g.id} computes`, () => w.ctx.contributions.graphEdges(g.id, scope));
  const failures = logs.slice(before_).filter((l) => l.includes("contributions"));
  if (failures.length) check("contributions run without errors", false, failures.join("\n"));
  const added = w.ctx.tools.list().filter((t) => !before.has(t.name)).map((t) => t.name);
  check("tools register", true, added.length ? added.join(", ") : "none");

  if (input.scenario) {
    const mod = await input.scenario();
    const run = mod.default as ((t: unknown) => unknown) | undefined;
    if (typeof run !== "function") check("scenario", false, "the scenario module has no default function");
    else {
      const api = {
        projectId: w.project.id,
        boardId: w.board.id,
        createItem: (title: string, patch: Record<string, unknown> = {}) => w.items.create({ projectId: w.project.id, boardId: w.board.id, title, by: "human", ...patch }),
        updateItem: (id: string, patch: Record<string, unknown>) => w.items.update(w.project.id, id, patch, "human"),
        items: () => w.items.list({ projectId: w.project.id }),
        tool: (name: string, args: unknown = {}) => w.ctx.tools.execute(name, args, { by: "human", projectId: w.project.id }),
        command: (id: string, itemId?: string) => w.ctx.contributions.run(id, { projectId: w.project.id, itemId }),
        badges: () => w.ctx.contributions.badgesFor(w.project.id),
        statusItems: () => w.ctx.contributions.statusItems(scope),
        sections: (itemId: string) => w.ctx.contributions.sectionsFor(w.project.id, itemId),
        graph: (id: string) => w.ctx.contributions.graphEdges(id, scope),
        sidebarModules: () => w.ctx.contributions.sidebarModules(w.project.id),
        check
      };
      try {
        await Promise.race([Promise.resolve(run(api)), timeout(20_000, "the scenario")]);
      } catch (error) {
        check("scenario", false, messageOf(error));
      }
    }
  }
  return { ok: checks.every((c) => c.ok), checks, logs };
}
