import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineAvailability, TurnPurpose } from "@tomradex/agent";

export const TomradeEngineConfig = z.object({
  /** Holds the backlog conversations: the loop, quick and tuned to the models it runs on. */
  backlog: z.string().default("loop"),
  /** Implements tickets — code and General work: the built-in pi. */
  work: z.string().default("pi-builtin")
}).prefault({});
export type TomradeEngineConfig = z.infer<typeof TomradeEngineConfig>;

// What both parts take; each part parses its own options from it.
const TomradeOptions = z.looseObject({ profile: z.string().optional(), effort: z.string().optional() });

/**
 * One choice for the in-app agent. A thread's purpose is fixed when it is made,
 * so a thread stays with one part and its history with it.
 */
export function createTomradeEngine(ctx: Context, config: TomradeEngineConfig): Engine {
  const part = (id: string) => ctx.agent.engineOf(id);
  const partFor = (purpose: TurnPurpose) => (purpose === "backlog" ? (part(config.backlog) ?? part(config.work)) : part(config.work));
  const either = () => part(config.backlog) ?? part(config.work);
  return {
    id: "tomrade",
    title: "Tomrade",
    author: "ai:agent",
    capabilities: ["backlog", "code", "general"],
    includes: [config.backlog, config.work],
    terminal: false,
    usesModels: true,
    steers: true,
    options: TomradeOptions,
    get permissionModes() {
      return part(config.work)?.permissionModes;
    },
    get diagnostics() {
      return part(config.work)?.diagnostics;
    },
    media: (options) => either()?.media?.(options) ?? { input: [], output: [] },
    picks: () => either()?.picks?.() ?? [],
    async available(opts): Promise<EngineAvailability> {
      const probe = async (id: string): Promise<EngineAvailability | null> => {
        const engine = part(id);
        if (!engine) return null;
        try {
          return await engine.available(opts);
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      };
      const [backlog, work] = await Promise.all([probe(config.backlog), probe(config.work)]);
      if (work?.ok) return { ok: true };
      if (backlog?.ok) return { ok: true, capabilities: ["backlog"] };
      const state = backlog ?? work ?? { ok: false, need: "service", reason: "No in-app agent is installed" };
      // With the built-in pi switched off, there is no ticket work to wait for.
      return work ? state : { ...state, capabilities: ["backlog"] };
    },
    async turn(input, io) {
      const engine = partFor(input.purpose);
      if (!engine) return { stop: "error", error: "No in-app agent is installed for this kind of work" };
      // A part's own saved settings still count, under what was picked for Tomrade and for this thread.
      const saved = (ctx.agent.settingsOf().engines[engine.id] ?? {}) as Record<string, unknown>;
      const options = { ...saved, ...((input.options ?? {}) as Record<string, unknown>) };
      return engine.turn({ ...input, options: engine.options ? engine.options.parse(options) : options }, io);
    }
  };
}

/** The model and effort picked for a part before Tomrade took it in become Tomrade's own, so the knobs show what runs. */
function adoptPartSettings(ctx: Context, config: TomradeEngineConfig): void {
  const agent = ctx.agent.settingsOf();
  if (agent.engines.tomrade) return;
  const picked: Record<string, unknown> = {};
  for (const id of [config.work, config.backlog]) {
    const options = (agent.engines[id] ?? {}) as Record<string, unknown>;
    for (const key of ["profile", "effort"]) if (typeof options[key] === "string" && options[key]) picked[key] = options[key];
  }
  if (!Object.keys(picked).length) return;
  const all = ctx.settings.get();
  ctx.settings.set({ ...all, agent: { ...agent, engines: { ...agent.engines, tomrade: picked } } });
}

export default {
  name: "engine-tomrade",
  inject: ["agent", "settings"],
  Config: TomradeEngineConfig,
  apply(ctx: Context, config: TomradeEngineConfig) {
    adoptPartSettings(ctx, config);
    ctx.agent.engine(createTomradeEngine(ctx, config));
  }
};
