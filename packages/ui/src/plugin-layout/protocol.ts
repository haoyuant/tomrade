import type { Item, Patch } from "@tomradex/domain";
import type { LayoutState, LayoutStateKey } from "@tomradex/plugin-sdk";

/**
 * What crosses between the window and a sandboxed layout's frame, over the
 * MessagePort the connect message carries. The host sends state once whole,
 * then only what changed; the frame calls back by id.
 */

export const CONNECT = "tomrade-layout:connect";

export interface ConnectMessage {
  type: typeof CONNECT;
  /** The layout's module, an absolute URL the frame imports. */
  module: string;
  state: LayoutState;
}

/** Tickets as they changed since the last message: new or changed ones whole, gone ones by id, the order only when it moved. */
export interface ItemsDelta {
  upsert: Item[];
  remove: string[];
  order?: string[];
}

export type HostMessage =
  | { type: "change"; changed: LayoutStateKey[]; items?: ItemsDelta; patch: Partial<Omit<LayoutState, "items">> }
  | { type: "result"; id: number; error?: string };

export type FrameCall = { method: "select"; args: [string | null] } | { method: "update"; args: [string, Patch] };

export type FrameMessage = ({ type: "call"; id: number } & FrameCall) | { type: "error"; message: string } | { type: "ready" };

/** Why `next` differs from `prev`, by reference on every key but the scalar. */
export function changedKeys(prev: LayoutState, next: LayoutState): Set<LayoutStateKey> {
  const changed = new Set<LayoutStateKey>();
  for (const key of Object.keys(next) as LayoutStateKey[]) if (prev[key] !== next[key]) changed.add(key);
  return changed;
}

/** The delta from one items list to the next: an item unchanged by reference costs nothing to send. */
export function diffItems(prev: Item[], next: Item[]): ItemsDelta {
  const before = new Map(prev.map((i) => [i.id, i]));
  const upsert: Item[] = [];
  let moved = prev.length !== next.length;
  next.forEach((item, i) => {
    if (before.get(item.id) !== item) upsert.push(item);
    if (!moved && prev[i]!.id !== item.id) moved = true;
  });
  const after = new Set(next.map((i) => i.id));
  const remove = prev.filter((i) => !after.has(i.id)).map((i) => i.id);
  return moved ? { upsert, remove, order: next.map((i) => i.id) } : { upsert, remove };
}

/** The items list a delta leaves: unchanged tickets keep their objects, so a layout can tell them apart by `===`. */
export function applyItems(prev: Item[], delta: ItemsDelta): Item[] {
  const byId = new Map(prev.map((i) => [i.id, i]));
  for (const id of delta.remove) byId.delete(id);
  for (const item of delta.upsert) byId.set(item.id, item);
  if (delta.order) return delta.order.flatMap((id) => byId.get(id) ?? []);
  const out = prev.flatMap((i) => (byId.has(i.id) ? [byId.get(i.id)!] : []));
  const seen = new Set(out.map((i) => i.id));
  for (const item of delta.upsert) if (!seen.has(item.id)) out.push(item);
  return out;
}
