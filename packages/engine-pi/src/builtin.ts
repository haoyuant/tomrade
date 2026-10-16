import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineAvailability, TurnInput } from "@tomradex/agent";
import { bundledLaunch, describeRun, RuntimePool, runtimeFingerprint, type CliLaunch } from "@tomradex/engine-claude-code";
import type { ModelProfile, ModelsSettings } from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";
import { listedModels, PERMISSION_MODES } from "./options.js";
import { PiRuntime, type PiLaunch } from "./rpc.js";
import { CATALOG_ENV, modelsFile, piTarget, usableProfile } from "./target.js";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const BuiltinPiConfig = z.object({
  /** The bundled `dist/bundle/cli.js`, run by the app's own binary as Node. */
  cli: z.string(),
  /** pi's config folder for this account — sessions and models.json; never the person's ~/.pi. */
  home: z.string(),
  /** The binary that runs it as Node; defaults to the running one. */
  nodeBinary: z.string().default(process.execPath)
});
export type BuiltinPiConfig = z.infer<typeof BuiltinPiConfig>;

export const BuiltinPiOptions = z.object({
  /** A model profile from Settings → Assistant; empty uses the first one pi can talk to. */
  profile: z.string().optional(),
  effort: z.string().optional()
});

function run(launch: CliLaunch, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string; stdout: string }> {
  const spec = launch.argv(args);
  return new Promise((resolve) => {
    execFile(spec.command, spec.args, { env: launch.env(env), timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exited = typeof error?.code === "number";
      const result = describeRun({ code: !error ? 0 : exited ? (error.code as number) : null, stdout: String(stdout), stderr: String(stderr), error: error && (error.killed || !exited) ? error : undefined }, 20_000);
      resolve({ ...result, stdout: String(stdout) });
    });
  });
}

/**
 * Pi shipped inside the app and run on Tomrade's own model profiles: a local
 * agent for Start that needs nothing installed and no sign-in of its own —
 * connecting a model is enough.
 */
export function createBuiltinPiEngine(ctx: Context, config: BuiltinPiConfig): Engine {
  const pool = new RuntimePool<PiRuntime>();
  ctx.effect(() => () => pool.close());
  const zh = () => ctx.settings.locale?.() === "zh";
  const launch = bundledLaunch({ file: config.cli, runtime: config.nodeBinary }, { platform: process.platform, env: process.env });
  const home = { PI_CODING_AGENT_DIR: config.home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const connected = (): ModelProfile[] => (ctx.settings.get().models as ModelsSettings | undefined)?.profiles ?? [];
  const profiles = (): ModelProfile[] => connected().filter(usableProfile);
  // A thread that picked a model pi cannot drive is not answered on another one.
  const refusedPick = (options: unknown): string | null => {
    const chosen = BuiltinPiOptions.safeParse(options ?? {}).data?.profile;
    const picked = chosen ? connected().find((p) => p.id === chosen) : undefined;
    if (!picked?.promptTools) return null;
    const name = picked.title || picked.model;
    return zh() ? `内置智能体不能用“${name}”：它不能自己调用工具` : `The built-in agent cannot run on "${name}": it does not call tools itself`;
  };
  const profileOf = (options: unknown): ModelProfile | undefined => {
    const all = profiles();
    const chosen = BuiltinPiOptions.parse(options ?? {}).profile;
    return all.find((p) => p.id === chosen) ?? all[0];
  };

  let started: Promise<{ ok: boolean; detail: string }> | null = null;
  const starts = (fresh?: boolean) => {
    if (fresh || !started) started = run(launch, ["--version"], { ...process.env, ...home });
    return started;
  };
  // The models pi knows by name, from its bundled catalog; a model it lists keeps pi's own metadata.
  let catalog: Promise<Set<string>> | null = null;
  const known = () =>
    (catalog ??= run(launch, ["--list-models", "--offline"], { ...process.env, ...home, ...CATALOG_ENV }).then((r) => new Set(r.ok ? listedModels(r.stdout) : [])));

  const start = async (input: TurnInput): Promise<PiLaunch> => {
    const refused = refusedPick(input.options);
    if (refused) throw new Error(refused);
    const profile = profileOf(input.options);
    if (!profile) throw new Error("Connect a model in Settings → Assistant — the built-in agent runs on it");
    fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config.home, "models.json"), JSON.stringify(modelsFile(profiles()), null, 2), { mode: 0o600 });
    const target = piTarget(profile, await known());
    const effort = BuiltinPiOptions.parse(input.options ?? {}).effort;
    return { launch, env: { ...home, ...target.env }, args: ["--model", target.model, ...(effort ? ["--thinking", effort] : [])] };
  };

  return {
    id: "pi-builtin",
    get title() {
      return zh() ? "内置智能体" : "Built-in agent";
    },
    author: "ai:pi",
    capabilities: ["backlog", "code", "general"],
    // Its key reaches pi only through Tomrade's environment, so there is no session to hand to a terminal.
    terminal: false,
    usesModels: true,
    steers: true,
    options: BuiltinPiOptions,
    media: (options) => {
      const profile = profileOf(options);
      return { input: (profile?.inputModalities?.includes("image") ?? profile?.provider === "anthropic") ? IMAGES : [], output: [] };
    },
    permissionModes: PERMISSION_MODES,
    picks: () => {
      const all = profiles();
      return [
        ...(all.length ? [{ key: "profile", title: "Model", choices: all.map((p) => ({ value: p.id, label: p.title || p.model })) }] : []),
        { key: "effort", title: "Effort", choices: EFFORTS.map((value) => ({ value })) }
      ];
    },
    async available(opts): Promise<EngineAvailability> {
      if (!fs.existsSync(config.cli)) return { ok: false, need: "install", reason: zh() ? "这个版本没有内置智能体——运行 `pnpm --filter @tomrade/desktop fetch:pi`" : "This build has no built-in agent — run `pnpm --filter @tomrade/desktop fetch:pi`" };
      if (!ctx.get("mcp")?.url) return { ok: false, need: "service", reason: zh() ? "MCP 服务没有运行——请启用 mcp 插件" : "The MCP server is not running — enable the mcp plugin" };
      if (!profiles().length) {
        const promptOnly = connected().some((p) => p.promptTools);
        return {
          ok: false,
          need: "model",
          reason: promptOnly
            ? zh() ? "已连接的模型不能自己调用工具，内置智能体需要一个能调用工具的模型" : "The connected models cannot call tools themselves — the built-in agent needs one that can"
            : zh() ? "先连接一个模型——内置智能体用它工作" : "Connect a model — the built-in agent runs on it"
        };
      }
      const refused = refusedPick(opts?.options);
      if (refused) return { ok: false, need: "model", reason: refused };
      const probe = await starts(opts?.fresh);
      if (!probe.ok) return { ok: false, need: "repair", reason: zh() ? `内置智能体启动失败：${probe.detail}` : `The built-in agent does not start: ${probe.detail}` };
      return { ok: true };
    },
    async turn(input, io) {
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      // A new key or model for the profile is a new process.
      const profile = createHash("sha256").update(JSON.stringify(profileOf(input.options) ?? null)).digest("hex");
      return pool.run(`${input.projectId}:${input.threadId}`, `${runtimeFingerprint(input, io, ctx.mcp.url)}:${profile}`,
        () => new PiRuntime(ctx, input, start), input, io);
    }
  };
}

export default {
  name: "engine-pi-builtin",
  inject: ["agent", "mcp", "tools", "settings"],
  Config: BuiltinPiConfig,
  apply(ctx: Context, config: BuiltinPiConfig) {
    ctx.agent.engine(createBuiltinPiEngine(ctx, config));
  }
};
