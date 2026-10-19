import type { Layout } from "@tomradex/code-sessions";

let counter = 0;
const nextId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

export const leaves = (layout: Layout): Extract<Layout, { type: "leaf" }>[] => (layout.type === "leaf" ? [layout] : [...leaves(layout.a), ...leaves(layout.b)]);

const map = (layout: Layout, id: string, fn: (node: Layout) => Layout): Layout => {
  if (layout.id === id) return fn(layout);
  return layout.type === "split" ? { ...layout, a: map(layout.a, id, fn), b: map(layout.b, id, fn) } : layout;
};

/** The cell split in two: it keeps its session on the left or top, the new half starts empty. */
export function split(layout: Layout, cell: string, direction: "row" | "column", id = nextId()): { layout: Layout; created: string } {
  return { layout: map(layout, cell, (node) => ({ type: "split", id: `${id}s`, direction, ratio: 0.5, a: node, b: { type: "leaf", id, sessionId: null } })), created: id };
}

/** The cell gone, its sibling taking the whole split; the last cell stays, emptied. */
export function close(layout: Layout, cell: string): Layout {
  if (layout.type === "leaf") return layout.id === cell ? { ...layout, sessionId: null } : layout;
  if (layout.a.id === cell) return layout.b;
  if (layout.b.id === cell) return layout.a;
  return { ...layout, a: close(layout.a, cell), b: close(layout.b, cell) };
}

/** Shows a session in a cell. One session shows in one cell at a time: herdr gives a pane's input to one controller. */
export function show(layout: Layout, cell: string, sessionId: string | null): Layout {
  const cleared = sessionId ? leaves(layout).filter((l) => l.sessionId === sessionId && l.id !== cell).reduce((acc, l) => map(acc, l.id, (n) => ({ ...n, sessionId: null }) as Layout), layout) : layout;
  return map(cleared, cell, (node) => (node.type === "leaf" ? { ...node, sessionId } : node));
}

export const resize = (layout: Layout, splitId: string, ratio: number): Layout => map(layout, splitId, (node) => (node.type === "split" ? { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) } : node));

/** Sessions that are gone from the list leave their cells empty. */
export const prune = (layout: Layout, known: Set<string>): Layout => leaves(layout).filter((l) => l.sessionId && !known.has(l.sessionId)).reduce((acc, l) => show(acc, l.id, null), layout);

/** The layout's shape alone, as a preset keeps it: every cell empty. */
export const shape = (layout: Layout): Layout => (layout.type === "leaf" ? { ...layout, sessionId: null } : { ...layout, a: shape(layout.a), b: shape(layout.b) });

/** An id into the first empty cell, in reading order; unchanged when every cell is taken. */
export function place(layout: Layout, id: string): Layout {
  const empty = leaves(layout).find((l) => !l.sessionId);
  return empty ? show(layout, empty.id, id) : layout;
}

/** A preset's shape with fresh cell ids, refilled in reading order with what the current layout showed; what does not fit is let go. */
export function applyPreset(current: Layout, preset: Layout, id = nextId): Layout {
  const renamed = (node: Layout): Layout => (node.type === "leaf" ? { type: "leaf", id: id(), sessionId: null } : { ...node, id: `${id()}s`, a: renamed(node.a), b: renamed(node.b) });
  return leaves(current)
    .flatMap((l) => (l.sessionId ? [l.sessionId] : []))
    .reduce((acc, shown) => place(acc, shown), renamed(shape(preset)));
}

