import path from "node:path";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type Engine } from "@tomradex/agent";
import { Im, ImSettings } from "@tomradex/im";
import { Contributions } from "@tomradex/contributions";
import type { AlertNotice } from "@tomradex/alerts";
import type { DesktopSurfaceSpec } from "@tomradex/desktop-surface";
import { cordisName } from "@tomradex/extensions";
import { Service, type Context } from "cordis";

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
  plugin: { inject?: string[]; optional?: string[]; config?: { safeParse(v: unknown): { success: boolean; data?: unknown } }; apply(ctx: unknown, config: unknown): unknown };
  id: string;
  namespace: string;
  dir: string;
  /** A directory the plugin may write: its data dir and the throwaway settings file go here. */
  tmp: string;
  /** Loads the plugin's scenario module the same way the plugin itself was loaded. */
  scenario: (() => Promise<Record<string, unknown>>) | null;
}

/** The sandbox's alerts: one system sound, and nothing played or shown — only remembered, for the scenario to read. */
function recordingAlerts() {
  const played: { sound: string; volume?: number }[] = [];
  const notices: AlertNotice[] = [];
  class Alerts extends Service {
    static provide = "alerts";
    constructor(ctx: Context) {
      super(ctx, "alerts");
    }
    sounds = () => [{ id: "system:Glass", title: "Glass" }];
    play = async (sound: string, opts?: { volume?: number }) => void played.push({ sound, ...opts });
    notify = (notice: AlertNotice) => void notices.push(notice);
  }
  return { Alerts, played, notices };
}

/** The sandbox's windows: none opens; each one is remembered with the last state it was given, and the scenario can speak for its document. */
function recordingSurfaces() {
  const opened: { spec: DesktopSurfaceSpec; state: unknown; closed: boolean }[] = [];
  class Surfaces extends Service {
    static provide = "desktopSurfaces";
    constructor(ctx: Context) {
      super(ctx, "desktopSurfaces");
    }
    open = (spec: DesktopSurfaceSpec) => {
      const entry = { spec, state: spec.initialState, closed: false };
      opened.push(entry);
      const area = { x: 0, y: 0, width: 1440, height: 900 };
      return {
        id: spec.id,
        capabilities: { programmaticPosition: true, forwardedMouseMoves: false },
        bounds: () => ({ x: 0, y: 0, width: spec.width, height: spec.height }),
        workArea: () => area,
        setPosition: () => {},
        setState: (state: unknown) => void (entry.state = state),
        close: () => void (entry.closed = true)
      };
    };
  }
  const view = () => opened.map((o) => ({ id: o.spec.id, title: o.spec.title, width: o.spec.width, height: o.spec.height, state: o.state, closed: o.closed }));
  const message = async (id: string, msg: unknown) => {
    const entry = [...opened].reverse().find((o) => o.spec.id === id && !o.closed);
    if (!entry) throw new Error(`no open window ${id}`);
    await entry.spec.onMessage?.(msg);
    await settle();
  };
  return { Surfaces, view, message };
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
  const wants = [...(p.inject ?? []), ...(p.optional ?? [])];
  const im = wants.includes("im");
  const alerts = wants.includes("alerts") ? recordingAlerts() : null;
  const surfaces = wants.includes("surfaces") ? recordingSurfaces() : null;
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(input.tmp, "settings.json") }], Contributions, ...(alerts ? [alerts.Alerts] : []), ...(surfaces ? [surfaces.Surfaces] : []), ...(im ? [Agent, Im] : [])] });
  try {
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
  // A plugin waiting on a service never applies, and says nothing of it: name what it waits for.
  const missing = fiber.state === 2 ? [] : (p.inject ?? []).filter((name) => !w.ctx.get(cordisName(name as never)));
  const loaded = fiber.state === 2 && !logs.some((l) => l.startsWith("error"));
  check("loads", loaded, missing.length
    ? `waits for ${missing.join(", ")}, which this sandbox does not provide; move ${missing.length > 1 ? "them" : "it"} to optional to load without ${missing.length > 1 ? "them" : "it"}`
    : (logs.find((l) => l.startsWith("error")) ?? (loaded ? undefined : "it did not start")));
  if (fiber.state !== 2) return { ok: false, checks, logs };

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
        ...(surfaces ? { surfaces: { opened: surfaces.view, message: surfaces.message } } : {}),
        ...(alerts ? { alerts: { played: () => [...alerts.played], notices: () => [...alerts.notices] } } : {}),
        ...(im ? { im: {
          configure: (settings: unknown) => w.ctx.settings.set({ ...w.ctx.settings.get(), im: ImSettings.parse(settings) }),
          engine: (engine: Engine) => w.ctx.agent.engine(engine),
          threads: () => w.ctx.agent.store.threads(w.project.id),
          thread: (id: string) => w.ctx.agent.thread(w.project.id, id),
          connections: () => w.ctx.im.views()
        } } : {}),
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
  } finally {
    if (im) {
      for (const run of w.ctx.agent.activeRuns()) w.ctx.agent.cancel(run.run.id);
      await settle();
    }
    await w.ctx.fiber.dispose();
  }
}
