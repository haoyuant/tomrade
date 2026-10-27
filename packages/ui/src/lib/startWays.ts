import { useSyncExternalStore } from "react";
import type { EngineView } from "@tomradex/agent";
import type { StartOptions } from "@tomradex/code-link";

/** Tomrade's own assistant: it runs in the panel, never in a terminal. */
const BUILTIN_ENGINE = "tomrade";

/**
 * How a start runs. `pane`: a terminal agent in a herdr pane, watched in the assistant panel; `window`: the same,
 * the Terminal window brought up too; `terminal`: a terminal app outside Tomrade; `here`: a headless run in the panel;
 * `builtin`: the built-in assistant in the panel.
 */
export type WayKind = "pane" | "window" | "terminal" | "here" | "builtin";

export interface StartWay {
  kind: WayKind;
  mode: StartOptions["mode"];
  engine: string;
  /** A start in a pane also brings up the Terminal window. */
  window: boolean;
}

export const wayKey = (way: Pick<StartWay, "kind" | "engine">): string => `${way.kind}:${way.engine}`;

/** Settings › Sessions › where new sessions run: the Terminal window comes up too only when the person said so. */
export const opensWindow = (sessions: unknown): boolean => (sessions as { newWhere?: string } | undefined)?.newWhere === "window";

/** The way one click goes: the mode and agent it would start with, placed by whether panes can take it and the setting. */
export function wayOf(input: { mode: StartOptions["mode"]; engine: string; panes: boolean; window: boolean }): StartWay {
  if (input.mode === "run") return { kind: input.engine === BUILTIN_ENGINE ? "builtin" : "here", mode: "run", engine: input.engine, window: false };
  if (!input.panes) return { kind: "terminal", mode: "terminal", engine: input.engine, window: false };
  return { kind: input.window ? "window" : "pane", mode: "terminal", engine: input.engine, window: input.window };
}

/**
 * The ▾ beside Start: the agent one click uses, in a background pane and with the Terminal window too; the other
 * terminal agents in a pane; the built-in assistant in the panel. Without panes, terminal agents open in a terminal
 * app and the first one can also run here. The one-click way always leads, so the menu never lacks it.
 */
export function startWays(input: {
  engines: Pick<EngineView, "id" | "ok" | "capabilities" | "terminal" | "terminalOnly">[] | undefined;
  capability: "code" | "general";
  /** The agent one click starts with. */
  primary: string | null;
  /** Terminal starts land in herdr panes that Tomrade can show. */
  panes: boolean;
  /** The way one click goes, when it is known. */
  quick?: StartWay | null;
  /** How many other terminal agents get a row. */
  others?: number;
}): StartWay[] {
  const usable = (input.engines ?? []).filter((e) => e.ok && e.capabilities.includes(input.capability));
  const inTerminal = usable.filter((e) => e.terminal !== false && e.id !== BUILTIN_ENGINE);
  const first = inTerminal.find((e) => e.id === input.primary) ?? inTerminal[0];
  const ways: StartWay[] = [];
  if (first) {
    if (input.panes) ways.push({ kind: "pane", mode: "terminal", engine: first.id, window: false }, { kind: "window", mode: "terminal", engine: first.id, window: true });
    else {
      ways.push({ kind: "terminal", mode: "terminal", engine: first.id, window: false });
      if (!first.terminalOnly) ways.push({ kind: "here", mode: "run", engine: first.id, window: false });
    }
  }
  for (const other of inTerminal.filter((e) => e !== first).slice(0, input.others ?? 2))
    ways.push(input.panes ? { kind: "pane", mode: "terminal", engine: other.id, window: false } : { kind: "terminal", mode: "terminal", engine: other.id, window: false });
  const builtin = usable.find((e) => e.id === BUILTIN_ENGINE && !e.terminalOnly);
  if (builtin) ways.push({ kind: "builtin", mode: "run", engine: builtin.id, window: false });
  const quick = input.quick;
  if (!quick) return ways;
  const at = ways.findIndex((way) => wayKey(way) === wayKey(quick));
  return at < 0 ? [quick, ...ways] : [ways[at]!, ...ways.filter((_, i) => i !== at)];
}

/** A start under way, before its session is there to show: on its ticket's Start, its card, and atop the session bar. */
export interface Starting {
  id: string;
  projectId: string;
  itemId: string;
  ticket: string;
  title: string;
  /** The agent's name, as the line says it. */
  agent: string;
  at: number;
}

let starting: readonly Starting[] = [];
let nextId = 0;
const startingListeners = new Set<() => void>();
const subscribeStarting = (listener: () => void) => {
  startingListeners.add(listener);
  return () => void startingListeners.delete(listener);
};

/** Shows a start as under way until the returned function is called. */
export function beginStarting(entry: Omit<Starting, "id" | "at">): () => void {
  const id = `starting-${++nextId}`;
  starting = [{ ...entry, id, at: Date.now() }, ...starting];
  for (const listener of startingListeners) listener();
  return () => {
    starting = starting.filter((e) => e.id !== id);
    for (const listener of startingListeners) listener();
  };
}

/** Every start under way; the same array until one begins or ends. */
export const useStartingAll = (): readonly Starting[] => useSyncExternalStore(subscribeStarting, () => starting);

/** This ticket's start under way, if any. */
export const useStartingFor = (itemId: string): Starting | null =>
  useSyncExternalStore(subscribeStarting, () => starting.find((e) => e.itemId === itemId) ?? null);
