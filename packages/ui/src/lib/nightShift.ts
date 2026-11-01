import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomradex/domain";
import type { NightShiftInput } from "@tomradex/night-shift";
import { invoke, subscribe } from "./api";
import { keys } from "./queries/keys";

function useLive(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => subscribe("nightShift.changed", (id) => id === projectId && void qc.invalidateQueries({ queryKey: keys.nightShift.all(projectId) })), [projectId, qc]);
}

export function useNightShift(projectId: string) {
  useLive(projectId);
  return useQuery({ queryKey: keys.nightShift.current(projectId), queryFn: () => invoke("nightShift.current", projectId), retry: false });
}

export const useLastNightShift = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.last(projectId), queryFn: async () => (await invoke("nightShift.list", projectId, 1))[0] ?? null, retry: false });

/** "Until it is done" still ends; the service holds the same limit. */
export const UNTIL_DONE_HOURS = 72;

/** One model call: kept while the dialog comes and goes, and asked again only by hand. */
export const useShiftPlan = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.plan(projectId), queryFn: () => invoke("nightShift.plan", projectId), retry: false, staleTime: 10 * 60_000 });

export function useNightShiftActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: keys.nightShift.all(projectId) });
  return {
    start: useMutation({ mutationFn: (input: NightShiftInput) => invoke("nightShift.start", projectId, input), onSuccess: done }),
    stop: useMutation({ mutationFn: (id: string) => invoke("nightShift.stop", projectId, id), onSuccess: done })
  };
}

/** True while the computer runs on battery; null where the browser cannot tell. */
export function useOnBattery(): boolean | null {
  const [onBattery, setOnBattery] = useState<boolean | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean }> };
    let gone = false;
    let release = () => {};
    void nav.getBattery?.().then((battery) => {
      if (gone) return;
      const read = () => setOnBattery(!battery.charging);
      read();
      battery.addEventListener("chargingchange", read);
      release = () => battery.removeEventListener("chargingchange", read);
    });
    return () => {
      gone = true;
      release();
    };
  }, []);
  return onBattery;
}

const OPEN_FOR_SHIFT = new Set<Item["status"]>(["todo", "backlog"]);

/** What a shift can be offered: tickets not begun, To Do first, then by priority. */
export function shiftCandidates(items: Item[]): Item[] {
  const rank = (item: Item) => (item.status === "todo" ? 0 : 1);
  return items.filter((item) => item.kind === "ticket" && OPEN_FOR_SHIFT.has(item.status)).sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || a.rank - b.rank);
}

/** What the plan chooses before anyone has answered it: To Do's coding work, as the backlog says. */
export const factsChosen = (candidates: Item[]): Set<string> => new Set(candidates.filter((i) => i.status === "todo" && i.workType === "coding").map((i) => i.id));

/** The tickets as they will stand once the dependencies the person took are written. */
export function withTaken(items: Item[], taken: readonly { from: string; to: string }[]): Item[] {
  if (!taken.length) return items;
  return items.map((item) => {
    const blocks = taken.filter((e) => e.from === item.id).map((e) => e.to);
    const blockedBy = taken.filter((e) => e.to === item.id).map((e) => e.from);
    return blocks.length || blockedBy.length ? { ...item, blocks: [...item.blocks, ...blocks], blockedBy: [...item.blockedBy, ...blockedBy] } : item;
  });
}

/** The chosen tickets with each after what it waits on, as the shift will try them; a cycle keeps the order it came in. */
export function shiftOrder(chosen: Item[]): Item[] {
  const left = new Map(chosen.map((item) => [item.id, item]));
  const out: Item[] = [];
  while (left.size) {
    const next = [...left.values()].find((item) => !item.blockedBy.some((id) => left.has(id))) ?? [...left.values()][0]!;
    out.push(next);
    left.delete(next.id);
  }
  return out;
}

export type ShiftNote = { kind: "after" | "after-merge" | "outside"; keys: string[] } | null;

/** Why a chosen ticket will not start at once, or at all: `open` holds every ticket still open, chosen or not. */
export function shiftNote(item: Item, chosen: ReadonlySet<string>, open: ReadonlyMap<string, Item>, autoMerge: boolean): ShiftNote {
  const waits = item.blockedBy.flatMap((id) => open.get(id) ?? []);
  const outside = waits.filter((b) => !chosen.has(b.id));
  if (outside.length) return { kind: "outside", keys: outside.map((b) => b.key) };
  if (!waits.length) return null;
  return { kind: autoMerge ? "after" : "after-merge", keys: waits.map((b) => b.key) };
}
