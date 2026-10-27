import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineAvailability, TurnInput } from "@tomradex/agent";
import { bundledLaunch, describeRun, pooledEngine, type CliLaunch } from "@tomradex/engine-kit";
import type { ModelProfile, ModelsSettings } from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/settings";
import { listedModels, PERMISSION_MODES } from "./options.js";
import { PiRuntime, type PiLaunch } from "./rpc.js";
import { CATALOG_ENV, modelsFile, piApi, piTarget, usableProfile, type PiProviders } from "./target.js";
import { PI_WORDS } from "./words.js";

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
  const words = () => PI_WORDS(ctx.settings.locale?.());
  const launch = bundledLaunch({ file: config.cli, runtime: config.nodeBinary }, { platform: process.platform, env: process.env });
  const home = { PI_CODING_AGENT_DIR: config.home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const connected = (): ModelProfile[] => (ctx.settings.get().models as ModelsSettings | undefined)?.profiles ?? [];
  // A plugin that declares the wire its endpoint speaks lets its profiles run here too.
  const kinds = (): PiProviders => new Map((ctx.get("llm")?.modelProviders() ?? []).flatMap((p) => (p.wire ? [[p.id, { api: p.wire, base: p.baseURL.default }] as const] : [])));
  const profiles = (): ModelProfile[] => connected().filter((p) => usableProfile(p, kinds()));
  // A thread that picked a model pi cannot drive is not answered on another one.
  const refusedPick = (options: unknown): string | null => {
    const chosen = BuiltinPiOptions.safeParse(options ?? {}).data?.profile;
    const picked = chosen ? connected().find((p) => p.id === chosen) : undefined;
    if (!picked) return null;
    const name = picked.title || picked.model;
    if (picked.promptTools) return words()("refusedPick", { name });
    return piApi(picked.provider, kinds()) ? null : words()("foreignPick", { name });
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
    if (!profile) throw new Error(words()("connectModelInSettings"));
    fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config.home, "models.json"), JSON.stringify(modelsFile(profiles(), kinds()), null, 2), { mode: 0o600 });
    const target = piTarget(profile, await known(), kinds());
    const effort = BuiltinPiOptions.parse(input.options ?? {}).effort;
    // pi reads the person's ~/.agents/skills whatever its config folder; those are theirs, not Tomrade's agent's.
    return { launch, env: { ...home, ...target.env }, args: ["--model", target.model, ...(effort ? ["--thinking", effort] : []), "--no-skills"] };
  };

  return {
    id: "pi-builtin",
    get title() {
      return words()("title");
    },
    author: "ai:pi",
    capabilities: ["backlog", "code", "general"],
    // Its key reaches pi only through Tomrade's environment, so there is no session to hand to a terminal.
    terminal: { mode: "none" },
    usesModels: true,
    steering: "forward",
    options: BuiltinPiOptions,
    media: (options) => {
      const profile = profileOf(options);
      return { input: (profile?.inputModalities?.includes("image") ?? profile?.provider === "anthropic") ? IMAGES : [], output: [] };
    },
    // a turn started under "ask" can be raised or narrowed while it runs
    liveModes: true,
    permissionModes: PERMISSION_MODES,
    local: {
      picks: () => {
        const all = profiles();
        return [
          ...(all.length ? [{ key: "profile", title: "Model", choices: all.map((p) => ({ value: p.id, label: p.title || p.model })) }] : []),
          { key: "effort", title: "Effort", choices: EFFORTS.map((value) => ({ value })) }
        ];
      }
    },
    async available(opts): Promise<EngineAvailability> {
      if (!fs.existsSync(config.cli)) return { ok: false, need: "install", reason: words()("notBundled") };
      if (!ctx.get("mcp")?.url) return { ok: false, need: "service", reason: words()("noMcp") };
      if (!profiles().length) {
        const promptOnly = connected().some((p) => p.promptTools);
        const foreign = connected().some((p) => !piApi(p.provider, kinds()));
        return {
          ok: false,
          need: "model",
          reason: words()(promptOnly ? "noToolModels" : foreign ? "foreignModels" : "connectModel")
        };
      }
      const refused = refusedPick(opts?.options);
      if (refused) return { ok: false, need: "model", reason: refused };
      // Ready means a model that answered, not one whose address merely looks right.
      const profile = profileOf(opts?.options);
      const name = profile ? profile.title || profile.model : "";
      const tested = profile ? ctx.get("llm")?.tested(profile) ?? null : null;
      if (!tested) return { ok: false, need: "model", reason: words()("testModel", { name }) };
      if (!tested.ok) return { ok: false, need: "model", reason: words()("testFailed", { name, detail: tested.detail ?? tested.kind ?? "" }) };
      const probe = await starts(opts?.fresh);
      if (!probe.ok) return { ok: false, need: "repair", reason: words()("doesNotStart", { detail: probe.detail }) };
      return { ok: true };
    },
    ...pooledEngine(ctx, {
      create: (input) => new PiRuntime(ctx, input, start),
      // A new key or model for the profile is a new process.
      fingerprint: (input) => createHash("sha256").update(JSON.stringify(profileOf(input.options) ?? null)).digest("hex")
    })
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
