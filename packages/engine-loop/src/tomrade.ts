import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineAvailability, TurnInput } from "@tomradex/agent";
import { errorMessage } from "@tomradex/contracts";
import { LOOP_WORDS } from "./words.js";

export const TomradeEngineConfig = z.object({
  /**
   * Holds the backlog conversations: the first of these in-app parts that can run. The built-in pi
   * held them better than the loop on the same model (pnpm eval:backlog); the loop stays as the backup.
   */
  backlog: z.union([z.string(), z.array(z.string()).min(1)]).default(["pi-builtin", "loop"]),
  /** Implements tickets — code and General work: the built-in pi. */
  work: z.string().default("pi-builtin"),
  /**
   * Signed-in local agents, in order, that hold a backlog conversation while no `backlog` part can run —
   * no model connected. Each stays a choice of its own, so they are not among `includes`.
   */
  fallback: z.array(z.string()).default(["claude-code", "codex"])
}).prefault({});
export type TomradeEngineConfig = z.infer<typeof TomradeEngineConfig>;

// What both parts take; each part parses its own options from it.
const TomradeOptions = z.looseObject({ profile: z.string().optional(), effort: z.string().optional() });

/** A borrowed agent's session is stored marked as its own, so no other part is handed it to resume. */
const borrowedSession = (id: string) => `@${id}:`;

/**
 * One choice for the in-app agent. A thread's purpose is fixed when it is made,
 * so a thread stays with one part and its history with it.
 */
export function createTomradeEngine(ctx: Context, config: TomradeEngineConfig): Engine {
  const part = (id: string) => ctx.agent.engineOf(id);
  const own = [config.backlog].flat();
  const ownPart = () => own.map(part).find(Boolean);
  const either = () => ownPart() ?? part(config.work);
  const words = () => LOOP_WORDS(ctx.settings.locale?.());
  const runs = async (engine: Engine | undefined, opts?: { fresh?: boolean; options?: unknown }): Promise<EngineAvailability | null> => {
    if (!engine) return null;
    try {
      return await engine.available(opts);
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  };
  const borrowable = async (opts?: { fresh?: boolean }): Promise<Engine | undefined> => {
    for (const id of config.fallback) {
      const engine = part(id);
      if (!engine || !(engine.capabilities ?? ["backlog"]).includes("backlog")) continue;
      if ((await runs(engine, opts))?.ok) return engine;
    }
    return undefined;
  };
  // A part's own saved settings still count, under what was picked for Tomrade and for this thread.
  // A borrowed agent keeps only its own: the model and effort picked here are for the in-app parts.
  const optionsFor = (engine: Engine, picked: unknown, borrowed: boolean): Record<string, unknown> => {
    const saved = (ctx.agent.settingsOf().engines[engine.id] ?? {}) as Record<string, unknown>;
    return borrowed ? saved : { ...saved, ...((picked ?? {}) as Record<string, unknown>) };
  };
  /** The first in-app part that can run with what was picked; otherwise the first signed-in local agent; otherwise the first part, to say what it needs. */
  const backlogPart = async (picked: unknown): Promise<{ engine: Engine | undefined; borrowed: boolean }> => {
    for (const id of own) {
      const engine = part(id);
      if (engine && (await runs(engine, { options: optionsFor(engine, picked, false) }))?.ok) return { engine, borrowed: false };
    }
    const borrowed = await borrowable();
    return borrowed ? { engine: borrowed, borrowed: true } : { engine: either(), borrowed: false };
  };
  return {
    id: "tomrade",
    title: "Tomrade",
    author: "ai:agent",
    capabilities: ["backlog", "code", "general"],
    includes: [...new Set([...own, config.work])],
    terminal: { mode: "none" },
    usesModels: true,
    // Its parts steer by their own protocol; a turn's io offers both.
    steering: "queue",
    options: TomradeOptions,
    get permissionModes() {
      return part(config.work)?.permissionModes;
    },
    get liveModes() {
      return part(config.work)?.liveModes;
    },
    local: {
      get diagnostics() {
        return part(config.work)?.local?.diagnostics;
      },
      picks: () => either()?.local?.picks?.() ?? []
    },
    media: (options) => either()?.media?.(options) ?? { input: [], output: [] },
    async available(opts): Promise<EngineAvailability> {
      const [work, ...backlogs] = await Promise.all([config.work, ...own].map((id) => runs(part(id), opts)));
      const backlog = backlogs.find((state) => state?.ok) ?? backlogs.find(Boolean);
      if (work?.ok) return { ok: true };
      // Why tickets cannot go to the built-in pi stays said, so setup can name it.
      if (backlog?.ok || (await borrowable(opts))) return { ok: true, capabilities: ["backlog"], ...(work?.reason ? { reason: work.reason } : {}) };
      const state = backlog ?? work ?? { ok: false, need: "service", reason: "No in-app agent is installed" };
      // With the built-in pi switched off, there is no ticket work to wait for.
      return work ? state : { ...state, capabilities: ["backlog"] };
    },
    async turn(input, io) {
      const { engine, borrowed } = input.purpose === "backlog" ? await backlogPart(input.options) : { engine: part(config.work), borrowed: false };
      if (!engine) return { stop: "error", error: "No in-app agent is installed for this kind of work" };
      const options = optionsFor(engine, input.options, borrowed);
      const turnInput: TurnInput = { ...input, options: engine.options ? engine.options.parse(options) : options };
      if (!borrowed) {
        // A borrowed agent's session is no use to an in-app part, which starts its own with the conversation carried in.
        const resume = io.resume?.startsWith("@") ? undefined : io.resume;
        return engine.turn(turnInput, resume === io.resume ? io : { ...io, resume });
      }
      // The mode was picked from the work part's choices; a borrowed agent only takes one of its own.
      const own = engine.permissionModes?.choices.some((choice) => choice.value === input.permissionMode);
      if (!own) delete turnInput.permissionMode;
      const mark = borrowedSession(engine.id);
      const resume = io.resume?.startsWith(mark) ? io.resume.slice(mark.length) : undefined;
      if (!resume)
        io.emit({
          type: "note",
          text: words()("holding", { engine: engine.title })
        });
      // a mode picked mid-turn reaches it only when it is one of its own
      const modeTo = io.modeTo && ((apply: (mode: string) => Promise<boolean>) => io.modeTo!((mode) => engine.permissionModes?.choices.some((choice) => choice.value === mode) ? apply(mode) : Promise.resolve(false)));
      const result = await engine.turn(turnInput, { ...io, resume, ...(modeTo ? { modeTo } : {}) });
      return result.resume ? { ...result, resume: mark + result.resume } : result;
    }
  };
}

/** The model and effort picked for a part before Tomrade took it in become Tomrade's own, so the knobs show what runs. */
function adoptPartSettings(ctx: Context, config: TomradeEngineConfig): void {
  const agent = ctx.agent.settingsOf();
  if (agent.engines.tomrade) return;
  const picked: Record<string, unknown> = {};
  for (const id of [config.work, ...[config.backlog].flat()]) {
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
