import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getNodesBounds, getViewportForBounds, type Node, type ReactFlowInstance } from "@xyflow/react";
import type { ItemStatus } from "@tomradex/domain";

/** Below this a card's title is too small to read. */
const FIT_MIN_ZOOM = 0.65;
// fitting a wide graph never shrinks the cards past reading; the rest is a pan away
export const FIT = { padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM };
export type GraphFit = typeof FIT;
const HOVER_ENTER_MS = 50;
const HOVER_LEAVE_MS = 120;
/** How far from the canvas edge a graph too big to fit starts. */
const FIT_INSET = 24;

// The blocker's status colours its arrows: a satisfied dependency reads quieter, and
// dashed, rather than vanishing; one being worked on reads in the accent.
const STATUS_STROKE: Record<ItemStatus, string> = {
  backlog: "var(--meta)",
  todo: "var(--meta)",
  doing: "var(--accent-light)",
  verifying: "var(--accent-light)",
  done: "var(--border)",
  cancelled: "var(--border)"
};
export const settledStatus = (status: ItemStatus | undefined) => status === "done" || status === "cancelled";
// Around the card in focus, direction speaks louder than status: what it waits on
// is amber (upstream), what waits on it is blue (downstream); dashes still say settled.
const UPSTREAM = "var(--warn)";
const DOWNSTREAM = "var(--accent-light)";

export interface GraphFocus {
  id: string;
  up: Set<string>;
  down: Set<string>;
}

/** The card under the pointer, else the pinned one, lights up what it waits on and what waits on it; the rest steps back. */
export function useGraphFocus(edges: { from: string; to: string }[], shownIds: ReadonlySet<string>, pinnedId: string | null) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Hover intent: a pointer sweeping across cards, or crossing the gap between two, does not strobe the graph.
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverSoon = (id: string | null) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverId(id), id ? HOVER_ENTER_MS : HOVER_LEAVE_MS);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const focusId = hoverId && shownIds.has(hoverId) ? hoverId : pinnedId && shownIds.has(pinnedId) ? pinnedId : null;
  const focus = useMemo((): GraphFocus | null => {
    if (!focusId) return null;
    const up = new Set<string>();
    const down = new Set<string>();
    for (const e of edges) {
      if (e.from === focusId) down.add(e.to);
      if (e.to === focusId) up.add(e.from);
    }
    return { id: focusId, up, down };
  }, [focusId, edges]);
  return { focus, hoverSoon };
}

/** A node's part in the focus: its class, and the colour of its ring. */
export function nodeLook(focus: GraphFocus | null, id: string): { className?: string; style?: CSSProperties } {
  if (!focus) return {};
  const ring = (colour: string) => ({ "--ring": colour }) as CSSProperties;
  if (id === focus.id) return { className: "is-focus" };
  if (focus.up.has(id)) return { className: "is-up", style: ring(UPSTREAM) };
  if (focus.down.has(id)) return { className: "is-down", style: ring(DOWNSTREAM) };
  return { className: "is-dim" };
}

/**
 * How a dependency is drawn. `quiet` is the plugin's "faint"; `stroke` overrides the blocker's status for a
 * line that means something else, and `dash` draws it dashed whatever its status.
 */
export function edgeLook(edge: { from: string; to: string }, status: ItemStatus | undefined, focus: GraphFocus | null, opts: { quiet?: boolean; danger?: boolean; stroke?: string; dash?: string } = {}) {
  // a loop is the plugin's to call; otherwise the blocker's status speaks
  const direction = !focus ? null : edge.to === focus.id ? "up" : edge.from === focus.id ? "down" : null;
  const stroke = opts.danger ? "var(--danger)" : direction === "up" ? UPSTREAM : direction === "down" ? DOWNSTREAM : opts.stroke ?? (status ? STATUS_STROKE[status] : opts.quiet ? "var(--border)" : "var(--meta)");
  const settled = !!opts.quiet || settledStatus(status);
  const lit = direction !== null;
  const dash = opts.dash ?? (settled ? "4 3" : null);
  return {
    flow: settled || opts.danger || opts.dash || (focus && !lit) ? undefined : stroke,
    className: !focus ? undefined : direction === "up" ? "is-up" : direction === "down" ? "is-down" : "is-dim",
    style: { stroke, strokeWidth: lit ? 2.5 : opts.danger ? 2 : 1.5, ...(dash ? { strokeDasharray: dash } : {}) }
  };
}

/** Fits the graph; one too big to fit at a readable size starts at its first column and top row rather than mid-graph. */
export function fitGraph(el: HTMLElement | null, flow: Pick<ReactFlowInstance, "fitView" | "getNodes" | "setViewport">, fit: GraphFit, duration?: number): void {
  const all: Node[] = flow.getNodes();
  if (!el || !all.length) return void flow.fitView({ ...fit, duration });
  const bounds = getNodesBounds(all);
  const v = getViewportForBounds(bounds, el.clientWidth, el.clientHeight, fit.minZoom, fit.maxZoom, fit.padding);
  void flow.setViewport({ zoom: v.zoom, x: Math.max(v.x, FIT_INSET - bounds.x * v.zoom), y: Math.max(v.y, FIT_INSET - bounds.y * v.zoom) }, { duration });
}
