import type { Context } from "cordis";
import { isSuspended, type Engine, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";

const CANCEL = "Cancel";

/**
 * No model in the driver's seat: the user picks a registered workflow from a
 * menu and the workflow's own steps do the rest. Deterministic, offline, and
 * the proof that an engine is just a conductor.
 */
export function createScriptedEngine(): Engine {
  return {
    id: "scripted",
    title: "Scripted (no model)",
    author: "ai:scripted",
    literal: true,
    available: async () => ({ ok: true }),
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      const startable = io.workflows.list().filter((w) => w.canStartEmpty);

      // Off-script input while a workflow waits: this engine has no judgment
      // to apply, so it re-asks — with a way out.
      if (input.pending) {
        const text = input.input.kind === "text" ? input.input.text.trim().toLowerCase() : "";
        if (text === "cancel" || text === "取消") {
          await io.tools.execute("cancel_workflow", {});
          io.emit({ type: "note", text: "Workflow cancelled." });
          return { stop: "end" };
        }
        io.emit({ type: "note", text: `Still waiting: ${input.pending.question.text} — pick one of the options, or type "cancel".` });
        return { stop: "asked" };
      }

      // An answer that names a workflow starts it; anything else shows the menu.
      if (input.input.kind === "answer") {
        const value = Array.isArray(input.input.value) ? input.input.value[0] : input.input.value;
        if (value === CANCEL) {
          io.emit({ type: "note", text: "Nothing started." });
          return { stop: "end" };
        }
        const chosen = startable.find((w) => w.title === value || w.id === value);
        if (chosen) {
          const outcome = await io.tools.execute(chosen.id, {});
          if (isSuspended(outcome)) return { stop: "asked" };
          io.emit({ type: "text", text: `${chosen.title} finished.` });
          return { stop: "end" };
        }
        // Not a menu choice: a workflow just finished with this answer — nothing left to conduct.
        return { stop: "end" };
      }

      if (!startable.length) {
        io.emit({ type: "text", text: "No workflows are installed. This engine only runs registered workflows — switch to a model engine, or install a plugin that provides workflows." });
        return { stop: "end" };
      }
      const result = await io.tools.execute("ask_user", {
        question: "Pick a workflow to run.",
        options: [...startable.map((w) => w.title), CANCEL]
      });
      return { stop: isSuspended(result) ? "asked" : "end" };
    }
  };
}

export default {
  name: "engine-scripted",
  inject: ["agent"],
  apply(ctx: Context) {
    ctx.agent.engine(createScriptedEngine());
  }
};
