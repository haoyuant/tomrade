import type { WriteIntent } from "@tomradex/write";
import type { Disposer, Events, PluginContext } from "@tomradex/plugin-sdk";
import type { Host } from "../host.js";
import { within } from "../scope.js";
import { CORDIS } from "../services.js";
import type { Facade, Fn } from "./shared.js";
import { errorMessage } from "@tomradex/contracts";

const on = <K extends keyof Events>(host: Host, event: K, listener: Events[K]): Disposer => {
  const fire = host.listen(listener as Fn, `on(${event})`);
  const off = (() => {
    switch (event) {
      case "write":
        return host.ctx.on("write/committed", (intent: WriteIntent) =>
          fire({ projectId: intent.projectId, entity: intent.entity, op: intent.op, id: intent.id, by: intent.by, via: intent.via ?? null, runId: intent.runId ?? null } as never)
        );
      case "tool.result":
        return host.ctx.on("tools/result", (call, outcome) =>
          fire(
            { name: call.name, args: call.args, author: call.by, projectId: call.projectId, runId: call.run?.id } as never,
            (outcome.ok ? { ok: true } : { ok: false, error: errorMessage(outcome.error) }) as never
          )
        );
      case "project.opened":
        return host.ctx.on("db/opened", (projectId: string) => fire(projectId as never));
      case "project.closed":
        return host.ctx.on("db/closed", (projectId: string) => fire(projectId as never));
      case "settings.changed":
        return host.ctx.on("settings/changed", () => fire());
      default:
        throw new Error(`unknown event "${String(event)}"`);
    }
  })();
  return host.disposerOf(off);
};

/** The plugin's own lifetime: events, optional services, effects and timers. */
export const lifecycle = ({ host, ns, logger }: Facade): Pick<PluginContext, "on" | "when" | "has" | "effect" | "interval"> => ({
  on: (event, listener) => on(host, event, listener),

  when: (name, fn) => {
    if (!host.allowed.has(name)) throw new Error(`${host.identity.id} did not name "${name}" in optional`);
    const fiber = host.ctx.inject([CORDIS[name]], (inner) => {
      const sub = host.over(inner);
      let dispose: Disposer | void;
      let gone = false;
      within(ns, () => fn(sub.context)).then(
        (d) => {
          if (gone) d?.();
          else dispose = d;
        },
        (error: unknown) => logger.warn(`when(${name}): ${errorMessage(error)}`)
      );
      return () => {
        gone = true;
        dispose?.();
      };
    });
    return host.disposerOf(() => void fiber.dispose());
  },

  has: (name) => host.allowed.has(name) && host.ctx.get(CORDIS[name]) !== undefined,

  effect: (fn) => {
    host.ctx.effect(() => {
      let dispose: Disposer | undefined;
      let gone = false;
      within(ns, fn).then(
        (d) => {
          if (gone) d();
          else dispose = d;
        },
        (error: unknown) => logger.warn(`effect: ${errorMessage(error)}`)
      );
      return () => {
        gone = true;
        dispose?.();
      };
    }, `${ns}.effect`);
  },

  interval: (fn, ms) => {
    const tick = host.listen(fn, "interval");
    return host.disposerOf(
      host.ctx.effect(() => {
        const timer = setInterval(tick, Math.max(ms, 1_000));
        return () => clearInterval(timer);
      }, `${ns}.interval`)
    );
  }
});
