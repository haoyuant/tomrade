import type { ToolDescriptor } from "@tomradex/tools";
import type { ThreadMessage } from "./thread.js";
import type { TurnPurpose } from "./turn.js";

/** Kits a conversation carries from its first request: a coding session needs its ticket's tools; the rest wait until asked for. */
export function carriedKits(purpose: TurnPurpose): string[] {
  return purpose === "code" ? ["code"] : [];
}

/**
 * The tools a turn's model is not offered up front: those of a kit its kind
 * does not carry, unless an earlier turn of the thread already used them.
 */
export function deferredTools(tools: ToolDescriptor[], purpose: TurnPurpose, history: readonly ThreadMessage[] = []): ToolDescriptor[] {
  const carried = new Set(carriedKits(purpose));
  const used = new Set(history.flatMap((m) => (m.block.type === "trace" ? [m.block.tool] : [])));
  return tools.filter((t) => t.kit && !carried.has(t.kit) && !used.has(t.name));
}

/**
 * "routines — recurring tickets on a schedule (create_template, list_templates)", one per kit: what
 * the model reads to know what it can load. Without names when space is short.
 */
export function kitLines(deferred: readonly ToolDescriptor[], purposes: Record<string, string> = {}, opts: { names?: boolean } = {}): string[] {
  const byKit = new Map<string, string[]>();
  for (const tool of deferred) if (tool.kit) byKit.set(tool.kit, [...(byKit.get(tool.kit) ?? []), tool.name]);
  return [...byKit].map(([kit, names]) => `${kit}${purposes[kit] ? ` — ${purposes[kit]}` : ""}${opts.names === false ? "" : ` (${names.join(", ")})`}`);
}
