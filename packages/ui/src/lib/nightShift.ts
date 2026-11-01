import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomradex/domain";
import type { NightShiftEdit, NightShiftInput, TicketState, WorkRule } from "@tomradex/night-shift";
import { invoke, subscribe } from "./api";
import { useRepos } from "./queries";
import { keys } from "./queries/keys";

function useLive(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => subscribe("nightShift.changed", (id) => id === projectId && void qc.invalidateQueries({ queryKey: keys.nightShift.all(projectId) })), [projectId, qc]);
}

export function useNightShift(projectId: string) {
  useLive(projectId);
  return useQuery({ queryKey: keys.nightShift.current(projectId), queryFn: () => invoke("nightShift.current", projectId), retry: false });
}

/** Whether to show a way in: an error means the plugin is off, and a project with no repository has nothing to run. */
export function useShiftOffered(projectId: string): boolean {
  const repos = useRepos(projectId);
  const going = useNightShift(projectId);
  return !going.isError && (!!going.data || !!repos.data?.length);
}

export const useLastNightShift = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.last(projectId), queryFn: async () => (await invoke("nightShift.list", projectId, 1))[0] ?? null, retry: false });

/** "Until it is done" still ends; the service holds the same limit. */
export const UNTIL_DONE_HOURS = 72;

/** What the person's limit starts at: the ceiling, not what runs. */
export const DEFAULT_MAX_CONCURRENCY = 4;
/** With no model to weigh the tickets, a run stays small. */
const CAUTIOUS_CONCURRENCY = 2;

/** How many a run takes at once: the agent's call, within the person's limit. */
export const runConcurrency = (limit: number, decided: number | null | undefined): number => Math.min(limit, decided ?? CAUTIOUS_CONCURRENCY);

/** One model call: kept while the dialog comes and goes, and asked again only by hand. */
export const useShiftPlan = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.plan(projectId), queryFn: () => invoke("nightShift.plan", projectId), retry: false, staleTime: 10 * 60_000 });

export const useWorkRules = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.rules(projectId), queryFn: () => invoke("nightShift.rules", projectId), retry: false });

export const useRuleMatches = (projectId: string) =>
  useQuery({ queryKey: keys.nightShift.ruleMatches(projectId), queryFn: () => invoke("nightShift.ruleMatches", projectId), retry: false });

/** Rules change what the plan left out, so a save reads both again, and the plan with them. */
export function useSetWorkRules(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: WorkRule[]) => invoke("nightShift.setRules", projectId, rules),
    onSuccess: (rules) => {
      qc.setQueryData(keys.nightShift.rules(projectId), rules);
      void qc.invalidateQueries({ queryKey: keys.nightShift.ruleMatches(projectId) });
    }
  });
}

export function useNightShiftActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: keys.nightShift.all(projectId) });
  return {
    start: useMutation({ mutationFn: (input: NightShiftInput) => invoke("nightShift.start", projectId, input), onSuccess: done }),
    stop: useMutation({ mutationFn: (id: string) => invoke("nightShift.stop", projectId, id), onSuccess: done }),
    edit: useMutation({ mutationFn: ({ id, change }: { id: string; change: NightShiftEdit }) => invoke("nightShift.edit", projectId, id, change), onSuccess: done })
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

export type NodeOverride = NonNullable<NightShiftInput["nodes"]>[string];

const AT_WORK = new Set<TicketState>(["running", "limited", "needs-you"]);
/** Taking this ticket off ends an agent at work. */
export const stopsAnAgent = (state: TicketState): boolean => AT_WORK.has(state);
/** What is finished stays, as the run's history. */
export const canLeave = (state: TicketState): boolean => state === "queued" || AT_WORK.has(state);

export type EditImpact =
  /** It waits on a ticket this change takes off the run. */
  | { kind: "orphaned"; key: string; keys: string[] }
  /** It joins the run, and waits on open tickets the run does not hold; they can join with it. */
  | { kind: "outside"; key: string; keys: string[]; ids: string[] };

/** What a draft does to the tickets it leaves behind, in plain view before it is applied. */
export function editImpact(items: readonly Item[], run: readonly { itemId: string; state: TicketState }[], adds: ReadonlySet<string>, removes: ReadonlySet<string>): EditImpact[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const inRun = new Set(run.map((t) => t.itemId));
  const stays = new Set([...inRun, ...adds].filter((id) => !removes.has(id)));
  const open = (id: string) => {
    const item = byId.get(id);
    return !!item && item.status !== "done" && item.status !== "cancelled";
  };
  const waiting = [...run.filter((t) => t.state === "queued").map((t) => t.itemId), ...adds].filter((id) => stays.has(id));
  return waiting.flatMap((id): EditImpact[] => {
    const item = byId.get(id);
    if (!item) return [];
    const missing = item.blockedBy.filter((b) => open(b) && !stays.has(b));
    const keysOf = (ids: string[]) => ids.map((b) => byId.get(b)!.key);
    const removed = missing.filter((b) => removes.has(b));
    const outside = missing.filter((b) => !removes.has(b));
    return [
      ...(removed.length ? [{ kind: "orphaned" as const, key: item.key, keys: keysOf(removed) }] : []),
      ...(outside.length && adds.has(id) ? [{ kind: "outside" as const, key: item.key, keys: keysOf(outside), ids: outside }] : [])
    ];
  });
}

/** One field of a node, and who set it: what the person did by hand beats a rule, and a rule beats the run. */
export function nodeConfig(override: NodeOverride | undefined, rule: WorkRule | undefined): { config: NodeOverride; from: "manual" | "rule" | "run" } {
  const { skip: _skip, ...ruled } = rule?.then ?? {};
  const config = { ...ruled, ...override };
  return { config, from: override && Object.keys(override).length ? "manual" : Object.keys(ruled).length ? "rule" : "run" };
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
