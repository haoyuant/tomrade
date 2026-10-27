import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, WindowState } from "@tomradex/code-sessions";
import { send } from "./bridge";
import { carryOn, dedupe, leaves, place, prune, reveal, show, type Key } from "./layout";
import { live } from "./lists";

const ASKED_GRACE_MS = 5000;

/** What can go into a cell by itself: a session with a terminal here that no terminal of the window already shows, and plain terminals. */
const placeableIds = (state: WindowState): string[] => {
  const folded = new Set(state.terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])));
  return [...state.sessions.filter((s) => s.pane && live(s) && !folded.has(s.id)).map((s) => s.id), ...state.terminals.filter((t) => t.pane && !t.sessionId).map((t) => t.id)];
};

/** A cell's id as the herdr pane it shows: a session and the terminal it runs in are one pane, never two cells. */
export const paneKey = (state: WindowState): Key => {
  const panes = new Map<string, string>();
  for (const s of [...(state.archive.rows ?? []), ...state.sessions]) if (s.pane) panes.set(s.id, s.pane);
  for (const t of state.terminals) if (t.pane) panes.set(t.id, t.pane);
  return (id) => (panes.has(id) ? `pane:${panes.get(id)}` : id);
};

export type Leaf = Extract<Layout, { type: "leaf" }>;

/** Sessions whose ticket finished while the agent goes on in their pane, to the row it goes on as; not those put in a cell to read. */
export const carriedOf = (state: WindowState, toRead: Set<string>): Map<string, string> =>
  new Map(state.sessions.flatMap((s) => (s.continuedIn && !toRead.has(s.id) ? [[s.id, s.continuedIn] as const] : [])));

/**
 * A pick or reveal that found its pane in a cell under another ticket of the same agent: the cell now reads as the one
 * picked. A terminal and the session its agent claimed are one row, and the cell keeps the id it has.
 */
export const asPicked = (state: WindowState, layout: Layout, cell: string, id: string, key: Key): Layout => {
  const held = leaves(layout).find((l) => l.id === cell)?.sessionId;
  const claimedBy = (terminal: string) => state.terminals.find((t) => t.id === terminal)?.sessionId;
  if (!held || held === id || claimedBy(held) === id || claimedBy(id) === held) return layout;
  return show(layout, cell, id, key);
};

/**
 * The window's cells: the layout the first state brings, kept by the window after that, with the cell selected last.
 * Changes are saved to the project's window.
 */
export function useWindowLayout(state: WindowState | null) {
  const [laid, setLayout] = useState<Layout | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // The first state brings the remembered layout; after that the window owns it, minus sessions that went.
  // A terminal just asked for may miss from a state sent before the ask arrived; its cell keeps it a moment.
  const asked = useRef(new Map<string, number>());
  // Ended sessions and closed terminals the person put in a cell to read: they stay, wherever their pane went on.
  const toRead = useRef(new Set<string>());
  // A closed terminal is known only once picked to read: a terminal closed from its cell leaves the cell empty.
  const known = useMemo(
    () => new Set([...(state?.sessions.map((s) => s.id) ?? []), ...(state?.archive.rows?.map((s) => s.id) ?? []), ...(state?.terminals.map((t) => t.id) ?? []), ...[...(state?.closedTerminals ?? []), ...(state?.archive.terminals ?? [])].filter((t) => toRead.current.has(t.id)).map((t) => t.id)]),
    [state?.sessions, state?.archive.rows, state?.archive.terminals, state?.terminals, state?.closedTerminals]
  );
  const current = useRef<Layout | null>(null);
  // What the first state already listed is not new: only what appears after it is placed.
  const seen = useRef<Set<string> | null>(null);
  const focusedNow = useRef(focused);
  focusedNow.current = focused;
  // Cells in the order they were selected, the last selected last: a pick that must not go to the selected cell goes to the least recent.
  const recent = useRef<string[]>([]);
  useEffect(() => {
    if (focused) recent.current = [...recent.current.filter((id) => id !== focused), focused];
  }, [focused]);
  const revealed = useRef(0);
  const change = useCallback((next: Layout) => {
    current.current = next;
    setLayout(next);
    send({ type: "layout", layout: next });
  }, []);
  useEffect(() => {
    if (!state) return;
    const now = Date.now();
    for (const [id, at] of asked.current) if (known.has(id) || now - at > ASKED_GRACE_MS) asked.current.delete(id);
    const key = paneKey(state);
    const kept = prune(current.current ?? state.layout, new Set([...known, ...asked.current.keys()]));
    // One pane in one cell: a cell that would show it a second time is emptied, and that is saved.
    const pruned = dedupe(carryOn(kept, carriedOf(state, toRead.current), key), key, focusedNow.current);
    const placeable = placeableIds(state);
    const fresh = seen.current ? placeable.filter((id) => !seen.current!.has(id)) : [];
    seen.current = new Set([...(seen.current ?? []), ...placeable]);
    let placed = state.autoPlace ? fresh.reduce((acc, id) => place(acc, id, key), pruned) : pruned;
    // Asked from outside (a start, "open in terminal", a ticket's earlier session): the session in a cell, that cell selected — once it has its pane, or ended, to read.
    const ask = state.reveal;
    if (ask && ask.at !== revealed.current && state.sessions.some((s) => s.id === ask.sessionId && (s.pane || s.endedAt !== null))) {
      revealed.current = ask.at;
      if (state.sessions.some((s) => s.id === ask.sessionId && s.endedAt !== null)) toRead.current.add(ask.sessionId);
      const shown = reveal(placed, ask.sessionId, focusedNow.current, key);
      placed = asPicked(state, shown.layout, shown.cell, ask.sessionId, key);
      setFocused(shown.cell);
    }
    if (placed !== kept) change(placed);
    else {
      current.current = pruned;
      setLayout(pruned);
    }
  }, [state, known, change]);
  return { laid, focused, setFocused, change, current, asked, recent, toRead };
}
