import { useSyncExternalStore } from "react";

/**
 * A project's tab strip. The Backlog tab is always there and never closes; it
 * remembers which view or workstream it was last showing. Every file opened
 * gets a tab of its own; folders share one browsing tab, which follows the
 * folder last opened. Routines, once opened, has one tab of its own beside
 * Backlog until it is closed. Kept per project in this browser only — a convenience,
 * like a folded sidebar, not something that travels.
 */
export type BacklogPlace = { kind: "view"; id: string } | { kind: "workstream"; id: string };

export interface FileTab {
  kind: "file" | "folder";
  path: string;
  /** A pinned version (`?id&v`), carried so going back to the tab lands on it again. */
  pin?: { id: string; v: string };
}

export interface TabsState {
  backlog: BacklogPlace | null;
  /** The Routines tab is open. */
  routines: boolean;
  tabs: FileTab[];
}

const EMPTY: TabsState = { backlog: null, routines: false, tabs: [] };
const storageKey = (projectId: string) => `tomrade.tabs.${projectId}`;

const cache = new Map<string, TabsState>();
const listeners = new Map<string, Set<() => void>>();

function read(projectId: string): TabsState {
  const hit = cache.get(projectId);
  if (hit) return hit;
  let state = EMPTY;
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "null") as Partial<TabsState> | null;
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.filter((t): t is FileTab => !!t && (t.kind === "file" || t.kind === "folder") && typeof t.path === "string");
      const backlog = raw.backlog && (raw.backlog.kind === "view" || raw.backlog.kind === "workstream") && typeof raw.backlog.id === "string" ? raw.backlog : null;
      state = { backlog, routines: raw.routines === true, tabs: onlyOneFolder(tabs) };
    }
  } catch {
    // storage blocked or garbled: start with the Backlog tab alone
  }
  cache.set(projectId, state);
  return state;
}

function write(projectId: string, next: TabsState): void {
  const prev = read(projectId);
  if (prev === next) return;
  cache.set(projectId, next);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    // the strip still works for this session
  }
  for (const l of listeners.get(projectId) ?? []) l();
}

const onlyOneFolder = (tabs: FileTab[]): FileTab[] => {
  let seen = false;
  return tabs.filter((t) => t.kind !== "folder" || (!seen && (seen = true)));
};

const samePin = (a?: FileTab["pin"], b?: FileTab["pin"]) => a?.id === b?.id && a?.v === b?.v;

export function useTabs(projectId: string): TabsState {
  return useSyncExternalStore(
    (l) => {
      let set = listeners.get(projectId);
      if (!set) listeners.set(projectId, (set = new Set()));
      set.add(l);
      return () => set!.delete(l);
    },
    () => read(projectId)
  );
}

export const tabsOf = read;

/** The Backlog tab now shows this view or workstream. */
export function rememberBacklog(projectId: string, place: BacklogPlace): void {
  const state = read(projectId);
  if (state.backlog?.kind === place.kind && state.backlog.id === place.id) return;
  write(projectId, { ...state, backlog: place });
}

/** The Routines tab opens, or closes. */
export function setRoutinesTab(projectId: string, open: boolean): void {
  const state = read(projectId);
  if (state.routines !== open) write(projectId, { ...state, routines: open });
}

/**
 * A file or folder was opened. A file gets its own tab — the one it already
 * has, or a new one after `after` (the tab it was opened from); a folder moves
 * the browsing tab, or opens it.
 */
export function openTab(projectId: string, tab: FileTab, after?: string | null): void {
  const state = read(projectId);
  const at = state.tabs.findIndex((t) => (tab.kind === "folder" ? t.kind === "folder" : t.kind === "file" && t.path === tab.path));
  if (at >= 0) {
    const cur = state.tabs[at]!;
    if (cur.path === tab.path && samePin(cur.pin, tab.pin)) return;
    const tabs = [...state.tabs];
    tabs[at] = tab;
    write(projectId, { ...state, tabs });
    return;
  }
  const from = after === undefined || after === null ? -1 : state.tabs.findIndex((t) => t.path === after);
  const tabs = [...state.tabs];
  tabs.splice(from >= 0 ? from + 1 : tabs.length, 0, tab);
  write(projectId, { ...state, tabs });
}

/** The tabs left once these are closed. */
export function closeTabs(projectId: string, drop: (tab: FileTab, index: number) => boolean): void {
  const state = read(projectId);
  const tabs = state.tabs.filter((t, i) => !drop(t, i));
  if (tabs.length !== state.tabs.length) write(projectId, { ...state, tabs });
}

/** A file or folder moved: its tab follows it, and so do the tabs of anything inside a moved folder. */
export function renameTabs(projectId: string, from: string, to: string): void {
  const state = read(projectId);
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.path === from || t.path.startsWith(`${from}/`)) {
      changed = true;
      const { pin: _pin, ...rest } = t;
      return { ...rest, path: to + t.path.slice(from.length) };
    }
    return t;
  });
  if (changed) write(projectId, { ...state, tabs });
}
