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
  title?: string;
  window?: boolean;
  tmp: string;
  scenario: string | null;
}

const MARK = "@@tomrade-sandbox@@";
const payload = JSON.parse(process.argv[2] ?? "{}") as Payload;

/** The host's own copies, as Node resolves them from here. */
const SHARED_NAMES = ["cordis", "@tomradex/plugin-sdk", "zod", "zod/v4", "zod/v4/core", "zod/mini"];
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
  const sdk = (await import(shared["@tomradex/plugin-sdk"]!)) as { isSdkPlugin(v: unknown): boolean };
  const mod = await load(payload.main);
  if (!sdk.isSdkPlugin(mod.default)) throw new Error("the default export is not a plugin made with definePlugin from @tomradex/plugin-sdk");
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

/** The Tomrade a plugin is tested against lives in @tomradex/plugin-host, so this package carries none of it. */
async function test() {
  const { testPlugin } = await import("@tomradex/plugin-host");
  const p = await plugin();
  const scenario = payload.scenario;
  report(await testPlugin({ plugin: p, id: payload.id, namespace: payload.namespace, title: payload.title, window: payload.window, dir: payload.dir, tmp: payload.tmp, scenario: scenario ? () => load(scenario) : null }));
}

(payload.mode === "inspect" ? inspect() : test()).catch((error) =>
  report(payload.mode === "inspect" ? { ok: false, error: messageOf(error), inject: [], optional: [], recording: null } : { ok: false, error: messageOf(error), checks: [], logs: [] })
).finally(() => setTimeout(() => process.exit(0), 10));
