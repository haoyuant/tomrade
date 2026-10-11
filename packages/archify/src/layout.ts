import dagre from "@dagrejs/dagre";

/**
 * Placement for architecture specs, so a model only has to say what the system is.
 * Models are poor at the coordinates Archify's checks demand (edges through nodes,
 * labels on top of nodes, crossings), and DeepSeek in particular never converged
 * by repairing them. A layered layout gets the geometry right by construction;
 * Archify's own validator then picks among a few variants.
 */

type Spec = Record<string, unknown>;
interface Component { id: string; label?: string; sublabel?: string; [key: string]: unknown }
interface Connection { from: string; to: string; label?: string; [key: string]: unknown }
interface Boundary { wraps?: string[]; [key: string]: unknown }

const GEOMETRY = ["pos", "size", "row", "col"];
const ROUTING = ["via", "fromSide", "toSide", "route", "channelX", "channelY", "labelAt", "labelDx", "labelDy", "labelSegment"];
const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/** Rough rendered width; CJK and fullwidth glyphs run about twice a Latin one. */
const textWidth = (text: unknown, wide: number, narrow: number) =>
  [...String(text ?? "")].reduce((width, ch) => width + (WIDE.test(ch) ? wide : narrow), 0);

const components = (spec: Spec) => (Array.isArray(spec.components) ? spec.components : []) as Component[];
const connections = (spec: Spec) => (Array.isArray(spec.connections) ? spec.connections : []) as Connection[];
const boundaries = (spec: Spec) => (Array.isArray(spec.boundaries) ? spec.boundaries : []) as Boundary[];

/** Sent with no placement at all: the author left the layout to diagram_render. */
export function unplaced(spec: Spec): boolean {
  const list = components(spec);
  return list.length > 0 && spec.layout === undefined && list.every((c) => c.pos === undefined && c.row === undefined && c.col === undefined);
}

/** What the diagram means, with every coordinate and route control taken out. */
export function semantic(spec: Spec): Spec {
  const out = structuredClone(spec);
  delete out.layout;
  delete out.viewBox;
  if (out.meta && typeof out.meta === "object") delete (out.meta as Spec).viewBox;
  for (const c of components(out)) for (const key of GEOMETRY) delete c[key];
  for (const e of connections(out)) for (const key of ROUTING) delete e[key];
  return out;
}

/** A fixed shuffle, so a seed always gives the same layout. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed * 9301 + 49297;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 9301 + 49297) % 233280;
    const j = Math.floor((state / 233280) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Variant { rankdir: "LR" | "TB"; nodesep: number; ranksep: number; seed: number; labels: "auto" | "reserved" }

export function arrange(base: Spec, { rankdir, nodesep, ranksep, seed, labels }: Variant): Spec {
  const spec = structuredClone(base);
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  const labelWidth = (label: unknown) => textWidth(label, 12, 6.5) + 16;
  graph.setGraph({ rankdir, nodesep, ranksep, edgesep: 30, marginx: 40, marginy: 90 });
  graph.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map<string, [number, number]>();
  // Insertion order steers dagre's crossing reduction; the seed varies it.
  for (const c of seed ? shuffled(components(spec), seed) : components(spec)) {
    const width = Math.round(Math.min(220, Math.max(140, Math.max(textWidth(c.label, 13, 7), textWidth(c.sublabel, 11, 6)) + 36)) / 10) * 10;
    const size: [number, number] = [width, c.sublabel ? 70 : 60];
    sizes.set(c.id, size);
    graph.setNode(c.id, { width: size[0], height: size[1] });
  }
  boundaries(spec).forEach((b, i) => {
    graph.setNode(`boundary:${i}`, { paddingTop: 36, paddingBottom: 24, paddingLeft: 24, paddingRight: 24 });
    for (const id of b.wraps ?? []) if (graph.hasNode(id) && !graph.parent(id)) graph.setParent(id, `boundary:${i}`);
  });
  const edges = connections(spec).map((e, i) => ({ e, name: `edge:${i}` }));
  for (const { e, name } of seed ? shuffled(edges, seed + 7) : edges)
    if (graph.hasNode(e.from) && graph.hasNode(e.to)) graph.setEdge(e.from, e.to, { width: e.label ? labelWidth(e.label) : 0, height: e.label ? 18 : 0 }, name);
  dagre.layout(graph);

  let right = 0;
  let bottom = 0;
  for (const c of components(spec)) {
    const node = graph.node(c.id);
    const [width, height] = sizes.get(c.id)!;
    c.pos = [Math.round((node.x - width / 2) / 10) * 10, Math.round((node.y - height / 2) / 10) * 10];
    c.size = [width, height];
    right = Math.max(right, (c.pos as number[])[0]! + width);
    bottom = Math.max(bottom, (c.pos as number[])[1]! + height);
  }
  // Archify picks left/right sides on its own, which stacked ranks break: name the facing sides.
  if (rankdir === "TB") {
    const centre = (id: string) => { const c = components(spec).find((x) => x.id === id)!; const [x, y] = c.pos as number[]; const [w, h] = c.size as number[]; return [x! + w! / 2, y! + h! / 2]; };
    for (const e of connections(spec)) {
      if (!sizes.has(e.from) || !sizes.has(e.to)) continue;
      const [fx, fy] = centre(e.from); const [tx, ty] = centre(e.to);
      if (Math.abs(ty! - fy!) >= 40) Object.assign(e, ty! > fy! ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" });
      else Object.assign(e, tx! > fx! ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" });
    }
  }
  // dagre left room for each label; pinning it there keeps sibling labels apart on dense maps.
  if (labels === "reserved")
    for (const { e, name } of edges) {
      const at = e.label && graph.hasEdge(e.from, e.to, name) ? graph.edge(e.from, e.to, name) : undefined;
      if (at && Number.isFinite(at.x)) e.labelAt = [Math.round(at.x!), Math.round(at.y!)];
    }
  const meta = (spec.meta && typeof spec.meta === "object" ? spec.meta : {}) as Spec;
  spec.meta = { ...meta, quality_profile: "showcase", viewBox: [Math.max(320, Math.ceil((right + 60) / 10) * 10), Math.max(240, Math.ceil((bottom + 60) / 10) * 10)] };
  return spec;
}

/** Candidate placements of the spec's meaning, the plainest first. */
export function arrangements(spec: Spec): Spec[] {
  const base = semantic(spec);
  const variants: Variant[] = [];
  for (const seed of [0, 1, 2]) for (const rankdir of ["LR", "TB"] as const) for (const labels of ["auto", "reserved"] as const) variants.push({ rankdir, nodesep: 50, ranksep: 40, seed, labels });
  return variants.map((variant) => arrange(base, variant));
}
