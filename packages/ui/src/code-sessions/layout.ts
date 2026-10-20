import type { Layout } from "@tomradex/code-sessions";

let counter = 0;
const nextId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

type Leaf = Extract<Layout, { type: "leaf" }>;

export const leaves = (layout: Layout): Leaf[] => (layout.type === "leaf" ? [layout] : [...leaves(layout.a), ...leaves(layout.b)]);

/** A leaf showing `sessionId`; a cell left empty is never locked. */
const holding = (leaf: Leaf, sessionId: string | null): Leaf => {
  const { locked, ...rest } = leaf;
  return sessionId && locked ? { ...rest, sessionId, locked } : { ...rest, sessionId };
};

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
  if (layout.type === "leaf") return layout.id === cell ? holding(layout, null) : layout;
  if (layout.a.id === cell) return layout.b;
  if (layout.b.id === cell) return layout.a;
  return { ...layout, a: close(layout.a, cell), b: close(layout.b, cell) };
}

/** What takes a cell's place once it is closed: the first cell of its sibling; null for the last cell. */
export function heir(layout: Layout, cell: string): string | null {
  if (layout.type === "leaf") return null;
  if (layout.a.id === cell) return leaves(layout.b)[0]!.id;
  if (layout.b.id === cell) return leaves(layout.a)[0]!.id;
  return heir(layout.a, cell) ?? heir(layout.b, cell);
}

type Box = { x: number; y: number; w: number; h: number };

/** Where each cell sits, as fractions of the window. */
export function boxes(layout: Layout, box: Box = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Box> {
  if (layout.type === "leaf") return new Map([[layout.id, box]]);
  const r = layout.ratio;
  const [a, b] =
    layout.direction === "row"
      ? [{ ...box, w: box.w * r }, { ...box, x: box.x + box.w * r, w: box.w * (1 - r) }]
      : [{ ...box, h: box.h * r }, { ...box, y: box.y + box.h * r, h: box.h * (1 - r) }];
  return new Map([...boxes(layout.a, a), ...boxes(layout.b, b)]);
}

const EDGE = 1e-6;

/** The cell across one edge of this one: of those touching it there, the one sharing most of it; null at the window's edge. */
export function neighbour(layout: Layout, cell: string, direction: "left" | "right" | "up" | "down"): string | null {
  const all = boxes(layout);
  const from = all.get(cell);
  if (!from) return null;
  const across = (b: Box) =>
    direction === "left" ? Math.abs(b.x + b.w - from.x) < EDGE : direction === "right" ? Math.abs(from.x + from.w - b.x) < EDGE : direction === "up" ? Math.abs(b.y + b.h - from.y) < EDGE : Math.abs(from.y + from.h - b.y) < EDGE;
  const shared = (b: Box) => (direction === "left" || direction === "right" ? Math.min(from.y + from.h, b.y + b.h) - Math.max(from.y, b.y) : Math.min(from.x + from.w, b.x + b.w) - Math.max(from.x, b.x));
  let best: { id: string; shared: number } | null = null;
  for (const [id, b] of all) {
    if (id === cell || !across(b)) continue;
    const s = shared(b);
    if (s > EDGE && (!best || s > best.shared + EDGE)) best = { id, shared: s };
  }
  return best?.id ?? null;
}

/** The cell before or after this one in reading order, going round. */
export function cycle(layout: Layout, cell: string, by: 1 | -1): string {
  const ids = leaves(layout).map((l) => l.id);
  const at = ids.indexOf(cell);
  return at < 0 ? ids[0]! : ids[(at + by + ids.length) % ids.length]!;
}

/** Shows a session in a cell. One session shows in one cell at a time: herdr gives a pane's input to one controller. */
export function show(layout: Layout, cell: string, sessionId: string | null): Layout {
  const cleared = sessionId ? leaves(layout).filter((l) => l.sessionId === sessionId && l.id !== cell).reduce((acc, l) => map(acc, l.id, (n) => holding(n as Leaf, null)), layout) : layout;
  return map(cleared, cell, (node) => (node.type === "leaf" ? holding(node, sessionId) : node));
}

/** A locked cell keeps what it shows until the person unlocks or closes it: nothing automatic replaces it. An empty cell does not lock. */
export const lock = (layout: Layout, cell: string, locked: boolean): Layout =>
  map(layout, cell, (node) => {
    if (node.type !== "leaf") return node;
    const { locked: _, ...rest } = node;
    return locked && node.sessionId ? { ...rest, locked: true } : rest;
  });

export const resize = (layout: Layout, splitId: string, ratio: number): Layout => map(layout, splitId, (node) => (node.type === "split" ? { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) } : node));

/** Sessions that are gone from the list leave their cells empty. */
export const prune = (layout: Layout, known: Set<string>): Layout => leaves(layout).filter((l) => l.sessionId && !known.has(l.sessionId)).reduce((acc, l) => show(acc, l.id, null), layout);

/** The layout's shape alone, as a preset keeps it: every cell empty and unlocked. */
export const shape = (layout: Layout): Layout => (layout.type === "leaf" ? holding(layout, null) : { ...layout, a: shape(layout.a), b: shape(layout.b) });

/** An id into the first empty cell, in reading order; unchanged when every cell is taken. */
export function place(layout: Layout, id: string): Layout {
  const empty = leaves(layout).find((l) => !l.sessionId && !l.locked);
  return empty ? show(layout, empty.id, id) : layout;
}

/**
 * Where a pick from the list lands. What a cell already shows (`shows` reads a cell's id as the session it shows): that
 * cell. With `beside` (⌘-click): a new cell beside the selected one. Else the selected cell, unless it is locked or
 * shows a session that needs the person; then the first empty cell, else the cell selected least recently (`recent`
 * lists cells, the last selected last) that is neither, else a new cell beside the selected one. `replaced` is what
 * the cell showed before.
 */
export function landing(
  layout: Layout,
  id: string,
  opts: { selected: string | null; beside?: boolean; recent?: string[]; needsYou?: (shown: string) => boolean; shows?: (cellId: string) => string; newId?: string }
): { layout: Layout; cell: string; replaced: string | null } {
  const cells = leaves(layout);
  const shows = opts.shows ?? ((cellId: string) => cellId);
  const already = cells.find((l) => l.sessionId && (l.sessionId === id || shows(l.sessionId) === id));
  if (already) return { layout, cell: already.id, replaced: null };
  const selected = cells.find((l) => l.id === opts.selected) ?? cells[0]!;
  const into = (cell: Leaf) => ({ layout: show(layout, cell.id, id), cell: cell.id, replaced: cell.sessionId });
  const beside = () => {
    const next = split(layout, selected.id, "row", opts.newId);
    return { layout: show(next.layout, next.created, id), cell: next.created, replaced: null };
  };
  if (opts.beside) return beside();
  const free = (cell: Leaf) => !cell.locked && !(cell.sessionId && opts.needsYou?.(cell.sessionId));
  if (free(selected)) return into(selected);
  const empty = cells.find((l) => !l.sessionId && !l.locked);
  if (empty) return into(empty);
  const recent = opts.recent ?? [];
  // Never selected counts as least recent; ties keep reading order.
  const other = cells.filter((l) => l.id !== selected.id && free(l)).sort((a, b) => recent.lastIndexOf(a.id) - recent.lastIndexOf(b.id))[0];
  return other ? into(other) : beside();
}

/**
 * A session brought into view: the cell that already shows it (`shows` reads a cell's id as the session it shows), else
 * the first empty cell, else a new cell beside `near`. Nothing else is moved out.
 */
export function reveal(layout: Layout, id: string, near: string | null, shows: (cellId: string) => string = (cellId) => cellId, newId = nextId()): { layout: Layout; cell: string } {
  const cells = leaves(layout);
  const holding = cells.find((l) => l.sessionId && shows(l.sessionId) === id);
  if (holding) return { layout, cell: holding.id };
  const empty = cells.find((l) => !l.sessionId && !l.locked);
  if (empty) return { layout: show(layout, empty.id, id), cell: empty.id };
  const beside = split(layout, (cells.find((l) => l.id === near) ?? cells[0]!).id, "row", newId);
  return { layout: show(beside.layout, beside.created, id), cell: beside.created };
}

/**
 * A preset's shape with fresh cell ids, refilled in reading order with what the current layout showed; what does not
 * fit is let go. Locked cells go first and stay locked, in cells added beside the last when the preset has too few.
 */
export function applyPreset(current: Layout, preset: Layout, id = nextId): Layout {
  const renamed = (node: Layout): Layout => (node.type === "leaf" ? { type: "leaf", id: id(), sessionId: null } : { ...node, id: `${id()}s`, a: renamed(node.a), b: renamed(node.b) });
  const shown = leaves(current).filter((l) => l.sessionId);
  return [...shown.filter((l) => l.locked), ...shown.filter((l) => !l.locked)].reduce((acc, l) => {
    if (!l.locked) return place(acc, l.sessionId!);
    const cells = leaves(acc);
    const empty = cells.find((c) => !c.sessionId);
    if (empty) return lock(show(acc, empty.id, l.sessionId), empty.id, true);
    const next = split(acc, cells.at(-1)!.id, "row", id());
    return lock(show(next.layout, next.created, l.sessionId), next.created, true);
  }, renamed(shape(preset)));
}

