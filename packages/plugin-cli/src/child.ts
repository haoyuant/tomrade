/**
 * The sandboxed side of runSandboxed. It is started with Node's permission
 * model on, so it reads only the plugin's folder and the host's runtime and
 * writes only its own temporary directory. The plugin is loaded from a data:
 * URL with its shared imports pointed at the host's files, which needs no
 * loader thread and so no permission to start one.
 */
import fs from "node:fs";
import path from "node:path";
import { emptyRecording, recordingContext } from "./record.js";

interface Payload {
  mode: "inspect" | "test";
  dir: string;
  main: string;
  id: string;
  namespace: string;
  tmp: string;
  scenario: string | null;
}

const MARK = "@@tomrade-sandbox@@";
const payload = JSON.parse(process.argv[2] ?? "{}") as Payload;

/** The host's own copies, as Node resolves them from here. */
const SHARED_NAMES = ["cordis", "@tomrade/plugin-sdk", "zod", "zod/v4", "zod/v4/core", "zod/mini"];
const shared: Record<string, string> = Object.fromEntries(
  SHARED_NAMES.flatMap((name) => {
    try {
      return [[name, import.meta.resolve(name)]];
    } catch {
      return [];
    }
  })
);
const report = (result: unknown) => process.stdout.write(`\n${MARK}${JSON.stringify(result)}\n`);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const timeout = (ms: number, what: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms));

const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

async function load(file: string): Promise<Record<string, unknown>> {
  const code = fs.readFileSync(file, "utf8").replace(IMPORT, (match, lead: string, quote: string, spec: string) => {
    if (shared[spec]) return `${lead}${quote}${shared[spec]}${quote}`;
    if (spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("file:")) return match;
    if (spec.startsWith(".")) throw new Error(`${path.basename(file)} imports "${spec}"; a plugin is one bundled file — build it with tomrade-plugin build`);
    if (/^[a-z@]/i.test(spec) && !/[\s(){}]/.test(spec)) throw new Error(`${path.basename(file)} imports "${spec}", which it must bundle (only ${Object.keys(shared).join(", ")} come from the host)`);
    return match;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as Record<string, unknown>;
}

type SdkPlugin = { inject?: string[]; optional?: string[]; config?: { safeParse(v: unknown): { success: boolean; data?: unknown } }; apply(ctx: unknown, config: unknown): unknown };

async function plugin(): Promise<SdkPlugin> {
  const sdk = (await import(shared["@tomrade/plugin-sdk"]!)) as { isSdkPlugin(v: unknown): boolean };
  const mod = await load(payload.main);
  if (!sdk.isSdkPlugin(mod.default)) throw new Error("the default export is not a plugin made with definePlugin from @tomrade/plugin-sdk");
  return mod.default as SdkPlugin;
}

const configOf = (p: SdkPlugin) => {
  const parsed = p.config?.safeParse(undefined);
  return parsed?.success ? parsed.data : undefined;
};

async function inspect() {
  const p = await plugin();
  const recording = emptyRecording();
  const ctx = recordingContext(payload.namespace, [...(p.inject ?? []), ...(p.optional ?? [])] as never, recording);
  try {
    await Promise.race([Promise.resolve(p.apply(ctx, configOf(p))), timeout(3_000, "apply()")]);
  } catch (error) {
    recording.stopped = messageOf(error);
  }
  report({ ok: true, inject: p.inject ?? [], optional: p.optional ?? [], recording });
}

async function test() {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const logs: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const { fresh, sdk, settle } = await import("@tomrade/testkit");
  const { Tools } = await import("@tomrade/tools");
  const { Settings } = await import("@tomrade/settings");
  const { Contributions } = await import("@tomrade/contributions");

  const p = await plugin();
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(payload.tmp, "settings.json") }], Contributions] });
  w.ctx.logger.exporter({ export: (m: { type: string; args: unknown[] }) => void (m.type === "error" || m.type === "warn" ? logs.push(`${m.type}: ${String(m.args[0])}`) : undefined) } as never);
  const samples = [
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "A sample issue", by: "human" }),
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Another in progress", status: "doing", by: "human" }),
    w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "One that is done", status: "done", by: "human" })
  ];
  const before = new Set(w.ctx.tools.list().map((t) => t.name));
  const fiber = w.ctx.plugin(sdk(p as never, { id: payload.id, namespace: payload.namespace, origin: "extension", root: payload.dir, dataDir: payload.tmp }), configOf(p));
  try {
    await Promise.race([fiber, timeout(5_000, "loading the plugin")]);
    await settle();
  } catch (error) {
    check("loads", false, messageOf(error));
    return report({ ok: false, checks, logs });
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
  for (const g of w.ctx.contributions.graphs()) await guarded(`graph ${g.id} computes`, () => w.ctx.contributions.graphEdges(g.id, scope));
  const failures = logs.slice(before_).filter((l) => l.includes("contributions"));
  if (failures.length) check("contributions run without errors", false, failures.join("\n"));
  const added = w.ctx.tools.list().filter((t) => !before.has(t.name)).map((t) => t.name);
  check("tools register", true, added.length ? added.join(", ") : "none");

  if (payload.scenario) {
    const mod = await load(payload.scenario);
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
        check
      };
      try {
        await Promise.race([Promise.resolve(run(api)), timeout(20_000, "the scenario")]);
      } catch (error) {
        check("scenario", false, messageOf(error));
      }
    }
  }
  report({ ok: checks.every((c) => c.ok), checks, logs });
}

(payload.mode === "inspect" ? inspect() : test()).catch((error) =>
  report(payload.mode === "inspect" ? { ok: false, error: messageOf(error), inject: [], optional: [], recording: null } : { ok: false, error: messageOf(error), checks: [], logs: [] })
).finally(() => setTimeout(() => process.exit(0), 10));
