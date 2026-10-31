import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  getNodesBounds,
  getViewportForBounds,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { toPng } from "html-to-image";
import "@xyflow/react/dist/style.css";
import type { Item, ItemStatus } from "@tomradex/domain";
import type { GraphEdge } from "@tomradex/contributions";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { Icon } from "~/components/icons";
import { useIssueWriter } from "~/components/issue/fields";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { askPanel } from "~/lib/panelRequests";
import { useGraphEdges, useGraphs } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { Card } from "./Card";
import { useSelectedId, useWorkspace } from "./context";

const NODE_W = 260;
const NODE_H = 92;

type IssueNode = Node<{ item: Item }, "issue">;

/** The same card the columns draw, wrapped in the handles a canvas needs. */
function IssueNodeView({ data }: NodeProps<IssueNode>) {
  const { select } = useWorkspace();
  return (
    <div className="gnode" style={{ width: NODE_W }}>
      <Handle type="target" position={Position.Left} />
      <Card item={data.item} onOpen={() => select(data.item.id)} onNudge={() => {}} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { issue: IssueNodeView };

interface XY {
  x: number;
  y: number;
}
type RoutedEdge = Edge<{ route?: XY[]; flow?: string }, "routed">;

const RANK_GAP = 96;
const CARD_GAP = 28;
/** Between the chains and the tickets below them that depend on nothing. */
const LONERS_GAP = 64;

/**
 * Blocker → blocked reads left to right, laid out by dagre at each card's
 * measured height; issues with no dependency in view line up in rows below.
 * Each arrow keeps dagre's route: through a column of cards it runs in the
 * lane dagre left between them, so it never passes under a card.
 */
function layout(items: Item[], edges: GraphEdge[], heights: Record<string, number>): { pos: Map<string, XY>; routes: Map<string, XY[]> } {
  const heightOf = (id: string) => heights[id] ?? NODE_H;
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: CARD_GAP, ranksep: RANK_GAP, edgesep: 14, acyclicer: "greedy" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const item of items) if (linked.has(item.id)) g.setNode(item.id, { width: NODE_W, height: heightOf(item.id) });
  for (const edge of edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  const pos = new Map<string, XY>();
  const columns = new Set<number>();
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    if (!linked.has(item.id)) continue;
    const n = g.node(item.id);
    pos.set(item.id, { x: n.x - NODE_W / 2, y: n.y - n.height / 2 });
    columns.add(n.x);
    left = Math.min(left, n.x - NODE_W / 2);
    right = Math.max(right, n.x + NODE_W / 2);
    bottom = Math.max(bottom, n.y + n.height / 2);
  }

  const routes = new Map<string, XY[]>();
  for (const edge of edges) {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (!from || !to || to.x <= from.x) continue;
    const route: XY[] = [{ x: from.x + NODE_W, y: from.y + heightOf(edge.from) / 2 }];
    for (const p of g.edge(edge.from, edge.to)?.points.slice(1, -1) ?? []) {
      // a bend inside a column of cards crosses it straight along its lane; bends between columns are dagre's spacing, not a route
      const column = [...columns].find((c) => Math.abs(c - p.x) < 1);
      if (column !== undefined) route.push({ x: column - NODE_W / 2, y: p.y }, { x: column + NODE_W / 2, y: p.y });
    }
    route.push({ x: to.x, y: to.y + heightOf(edge.to) / 2 });
    routes.set(`${edge.from}>${edge.to}`, route);
  }

  const loners = items.filter((i) => !linked.has(i.id));
  if (loners.length) {
    const width = linked.size ? right - left : 0;
    const perRow = Math.max(Math.floor((width + CARD_GAP) / (NODE_W + CARD_GAP)), Math.min(4, Math.ceil(Math.sqrt(loners.length))));
    const x0 = linked.size ? left : 0;
    let y = linked.size ? bottom + LONERS_GAP : 0;
    for (let i = 0; i < loners.length; i += perRow) {
      const row = loners.slice(i, i + perRow);
      row.forEach((item, j) => pos.set(item.id, { x: x0 + j * (NODE_W + CARD_GAP), y }));
      y += Math.max(...row.map((item) => heightOf(item.id))) + CARD_GAP;
    }
  }
  return { pos, routes };
}

/** Level runs stay straight; a change of lane bends with level tangents, so every arrowhead lands flat. */
function routePath(points: XY[]): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const mid = (a.x + b.x) / 2;
    d += Math.abs(a.y - b.y) < 0.5 ? ` L${b.x},${b.y}` : ` C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

/** Handles sit a few pixels outside the card; past that the card has moved off its route. */
const ROUTE_SLACK = 8;
const near = (p: XY, x: number, y: number) => Math.abs(p.x - x) <= ROUTE_SLACK && Math.abs(p.y - y) <= ROUTE_SLACK;

/** The dot travels at one speed, so a long dependency takes longer to cross than a short one. */
const FLOW_SPEED = 110;

/**
 * dagre's route while both cards sit where it put them; a dragged card, or a loop, falls back to a plain curve.
 * An unfinished dependency carries a dot from the blocker to what it blocks, in `data.flow`'s colour.
 */
function RoutedEdgeView({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style, interactionWidth }: EdgeProps<RoutedEdge>) {
  const route = data?.route;
  const points =
    route && near(route[0], sourceX, sourceY) && near(route[route.length - 1], targetX, targetY)
      ? [{ x: sourceX, y: sourceY }, ...route.slice(1, -1), { x: targetX, y: targetY }]
      : null;
  const path = points ? routePath(points) : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0];
  const length = (points ?? [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }]).reduce((sum, p, i, all) => (i ? sum + Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) : 0), 0);
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
      {data?.flow && (
        <circle className="edge-flow" r={3} style={{ fill: data.flow }}>
          <animateMotion dur={`${Math.max(1.2, length / FLOW_SPEED).toFixed(2)}s`} repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}

const edgeTypes = { routed: RoutedEdgeView };

/** Below this a card's title is too small to read. */
const FIT_MIN_ZOOM = 0.65;
// fitting a wide graph never shrinks the cards past reading; the rest is a pan away
const FIT = { padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM };
/** How far from the canvas edge a graph too big to fit starts. */
const FIT_INSET = 24;
const EXPORT_PAD = 32;
/** Past this many pixels a side, a browser canvas comes back blank. */
const EXPORT_MAX_SIDE = 16000;

/** The colour the canvas shows through to, for an image that has no page behind it. */
function backdropOf(el: Element | null): string {
  for (let n = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return "#fff";
}

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
const settledStatus = (status: ItemStatus | undefined) => status === "done" || status === "cancelled";
/** The ring a card related to the selected one wears: still open, being worked on, or out of the way. */
const STATUS_RING: Record<ItemStatus, string> = {
  backlog: "var(--warn)",
  todo: "var(--warn)",
  doing: "var(--accent-light)",
  verifying: "var(--accent-light)",
  done: "var(--success)",
  cancelled: "var(--border-input)"
};

function Canvas() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const selectedId = useSelectedId();
  const { write } = useIssueWriter(ws.project.id);
  const { fitView, getNodes, setViewport } = useReactFlow();
  const { setAiOpen } = useAgentDock();
  const toast = useToast();
  const region = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const graphs = useGraphs();
  // The view names its edge source; a view saved before any plugin contributed one falls back to the first.
  const graphId = ws.query.graph ?? graphs.data?.[0]?.id ?? null;
  const graph = (graphs.data ?? []).find((g) => g.id === graphId);
  const serverEdges = useGraphEdges(ws.project.id, graphId);
  const editable = graph?.edits === "blocks";

  // The filter decides which issues are nodes; the sort is irrelevant on a canvas.
  const visibleIds = useMemo(() => new Set(ws.visible.map((i) => i.id)), [ws.visible]);
  const statusOf = useMemo(() => new Map(ws.visible.map((i) => [i.id, i.status])), [ws.visible]);
  // A ticket with dependencies but none still live — both ends open — says nothing the graph is
  // for; it steps out of the picture, and a foot button brings those back.
  const [showSettled, setShowSettled] = useState(false);
  const settledIds = useMemo(() => {
    const linked = new Set<string>();
    const live = new Set<string>();
    const open = (id: string) => !settledStatus(statusOf.get(id));
    for (const e of serverEdges.data ?? []) {
      if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) continue;
      linked.add(e.from).add(e.to);
      if (open(e.from) && open(e.to)) live.add(e.from).add(e.to);
    }
    return new Set([...linked].filter((id) => !live.has(id)));
  }, [serverEdges.data, visibleIds, statusOf]);
  const shown = useMemo(() => (showSettled || !settledIds.size ? ws.visible : ws.visible.filter((i) => !settledIds.has(i.id))), [ws.visible, showSettled, settledIds]);
  const shownIds = useMemo(() => new Set(shown.map((i) => i.id)), [shown]);
  const edges = useMemo(() => (serverEdges.data ?? []).filter((e) => shownIds.has(e.from) && shownIds.has(e.to)), [serverEdges.data, shownIds]);

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<IssueNode>([]);

  // Only a completed drag earns a sticky position; everything else is
  // re-laid-out on every data change so a stale pre-edges-loaded layout
  // (dagre with no edges yet — see `layout`) never survives once the real
  // edges arrive.
  const dragged = useRef(new Map<string, { x: number; y: number }>());
  /** Whether the person has panned, zoomed or dragged: from then on the viewport is theirs. */
  const touched = useRef(false);
  // Cards grow with their title and labels; the layout spaces them by what they measure.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onNodesChange = (changes: NodeChange<IssueNode>[]) => {
    const measured: Record<string, number> = {};
    for (const c of changes) {
      if (c.type === "position" && c.position && c.dragging === false) {
        dragged.current.set(c.id, c.position);
        touched.current = true;
      }
      if (c.type === "dimensions" && c.dimensions && Math.abs((heights[c.id] ?? 0) - c.dimensions.height) > 1) measured[c.id] = c.dimensions.height;
    }
    if (Object.keys(measured).length) setHeights((h) => ({ ...h, ...measured }));
    onNodesChangeInternal(changes);
  };

  const edgeShape = edges.map((e) => `${e.from}>${e.to}`).join();
  // dagre runs when the nodes or the edges change, not when a card is selected
  const placed = useMemo(() => layout(shown, edges, heights), [shown, edgeShape, heights]); // eslint-disable-line react-hooks/exhaustive-deps
  // A selected card lights up what it waits on and what waits on it; the rest steps back.
  const focus = useMemo(() => {
    if (!selectedId || !shownIds.has(selectedId)) return null;
    const related = new Set([selectedId]);
    for (const e of edges) {
      if (e.from === selectedId) related.add(e.to);
      if (e.to === selectedId) related.add(e.from);
    }
    return related;
  }, [selectedId, shownIds, edges]);

  useEffect(() => {
    setNodes(
      shown.map((item) => ({
        id: item.id,
        type: "issue" as const,
        position: dragged.current.get(item.id) ?? placed.pos.get(item.id) ?? { x: 0, y: 0 },
        data: { item },
        deletable: false,
        connectable: editable,
        selected: item.id === selectedId,
        className: focus ? (focus.has(item.id) ? (item.id === selectedId ? "is-focus" : "is-related") : "is-dim") : undefined,
        style: focus?.has(item.id) && item.id !== selectedId ? ({ "--ring": STATUS_RING[item.status] } as CSSProperties) : undefined
      }))
    );
  }, [shown, placed, editable, selectedId, focus, setNodes]);

  /** Fits the graph; one too big to fit at a readable size starts at its first column and top row rather than mid-graph. */
  const fitGraph = (duration?: number) => {
    const el = region.current;
    const all = getNodes();
    if (!el || !all.length) return void fitView({ ...FIT, duration });
    const bounds = getNodesBounds(all);
    const v = getViewportForBounds(bounds, el.clientWidth, el.clientHeight, FIT.minZoom, FIT.maxZoom, FIT.padding);
    void setViewport({ zoom: v.zoom, x: Math.max(v.x, FIT_INSET - bounds.x * v.zoom), y: Math.max(v.y, FIT_INSET - bounds.y * v.zoom) }, { duration });
  };
  const fitGraphRef = useRef(fitGraph);
  fitGraphRef.current = fitGraph;

  // The first fit lands before the cards are measured, and the layout moves as they are: the
  // graph stays fitted through that until the person pans, zooms or drags a card themselves.
  const settled = shown.length > 0 && shown.every((i) => heights[i.id] !== undefined);
  useEffect(() => {
    if (!settled || touched.current) return;
    const frame = requestAnimationFrame(() => fitGraphRef.current());
    return () => cancelAnimationFrame(frame);
  }, [settled, placed]);

  const flowEdges = useMemo<RoutedEdge[]>(
    () =>
      edges.map((e) => {
        const status = statusOf.get(e.from);
        // a loop is the plugin's to call; otherwise the blocker's status speaks
        const stroke = e.tone === "danger" ? "var(--danger)" : status ? STATUS_STROKE[status] : e.tone === "faint" ? "var(--border)" : "var(--meta)";
        const settled = e.tone === "faint" || settledStatus(status);
        const lit = focus ? focus.has(e.from) && focus.has(e.to) && (e.from === selectedId || e.to === selectedId) : false;
        return {
          id: `${e.from}>${e.to}`,
          type: "routed" as const,
          source: e.from,
          target: e.to,
          data: { route: placed.routes.get(`${e.from}>${e.to}`), flow: settled || e.tone === "danger" || (focus && !lit) ? undefined : stroke },
          title: e.title,
          className: focus ? (lit ? "is-related" : "is-dim") : undefined,
          selectable: editable,
          deletable: editable,
          style: { stroke, strokeWidth: lit ? 2.5 : e.tone === "danger" ? 2 : 1.5, ...(settled ? { strokeDasharray: "4 3" } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: stroke }
        };
      }),
    [edges, editable, placed, statusOf, focus, selectedId]
  );

  const findItem = (id: string) => ws.items.find((i) => i.id === id);

  /** Dragging source → target draws "source blocks target"; the service refuses a loop and the toast repeats why. */
  const onConnect = (connection: Connection) => {
    if (!editable || !connection.source || !connection.target || connection.source === connection.target) return;
    const source = findItem(connection.source);
    const target = findItem(connection.target);
    if (!source || !target || source.blocks.includes(target.id)) return;
    write(source, { blocks: [...source.blocks, target.id] }, t("graphView.linkedToast", { from: source.key, to: target.key }));
  };

  const onEdgesDelete = (deleted: Edge[]) => {
    for (const edge of deleted) {
      const source = findItem(edge.source);
      const target = findItem(edge.target);
      if (!source || !target || !source.blocks.includes(target.id)) continue;
      write(source, { blocks: source.blocks.filter((id) => id !== target.id) }, t("graphView.unlinkedToast", { from: source.key, to: target.key }));
    }
  };

  /** The assistant rechecks the whole backlog's dependencies and asks before it changes any. */
  const updateDependencies = () => {
    setAiOpen(true);
    askPanel({ kind: "startWith", text: t("graphView.updateDepsPrompt") });
  };

  /** Every card at full size, not the part the viewport shows. */
  const exportImage = async () => {
    const viewport = region.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport || !nodes.length) return;
    setExporting(true);
    // Card icons point into the page's sprite, which is not in the picture; carry the ones in use along.
    const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sprite.setAttribute("width", "0");
    sprite.setAttribute("height", "0");
    sprite.style.position = "absolute";
    const defs = sprite.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    for (const href of new Set([...viewport.querySelectorAll("use")].map((u) => u.getAttribute("href")))) {
      const symbol = href?.startsWith("#") ? document.getElementById(href.slice(1)) : null;
      if (symbol) defs.appendChild(symbol.cloneNode(true));
    }
    viewport.appendChild(sprite);
    try {
      const bounds = getNodesBounds(getNodes());
      const width = Math.ceil(bounds.width + EXPORT_PAD * 2);
      const height = Math.ceil(bounds.height + EXPORT_PAD * 2);
      const dataUrl = await toPng(viewport, {
        width,
        height,
        pixelRatio: Math.min(2, EXPORT_MAX_SIDE / Math.max(width, height)),
        backgroundColor: backdropOf(region.current),
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${EXPORT_PAD - bounds.x}px, ${EXPORT_PAD - bounds.y}px) scale(1)` },
        // the drag handles are for editing and the flowing dots for watching, not for the picture
        filter: (n) => !(n instanceof Element && (n.classList.contains("react-flow__handle") || n.classList.contains("edge-flow")))
      });
      const name = `${ws.project.name} - ${ws.view.name}`.replace(/[\\/:*?"<>|]+/g, "-");
      const saved = await invoke("shell.saveImageFile", { title: t("graphView.exportTitle"), defaultName: `${name}.png`, dataUrl });
      if (saved) toast({ body: t("graphView.exported") });
    } catch (error) {
      toast(errorSpec(error));
    } finally {
      sprite.remove();
      setExporting(false);
    }
  };

  return (
    <div className="graph-region" data-graph={graphId ?? undefined} ref={region}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onPaneClick={() => ws.select(null)}
        // a null event is a move the code made, such as a fit
        onMoveStart={(event) => void (event && (touched.current = true))}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--border-soft)" />
      </ReactFlow>
      {shown.length === 0 && <p className="col-empty graph-empty">{t("graphView.empty")}</p>}
      {!graphId && <p className="col-empty graph-empty">{t("graphView.noGraph")}</p>}
      <div className="graph-foot">
        <span className="meta-txt dense graph-hint" title={editable ? t("graphView.editHint") : t("graphView.readOnlyHint")}>
          {editable ? t("graphView.editHint") : t("graphView.readOnlyHint")}
        </span>
        <div className="graph-actions">
          {settledIds.size > 0 && (
            <button type="button" className="btn btn-ghost" data-testid="graph-settled" title={t("graphView.settledHint")} aria-pressed={showSettled} onClick={() => setShowSettled((v) => !v)}>
              <Icon name={showSettled ? "i-eye-off" : "i-eye"} size={13} /> {t(showSettled ? "graphView.hideSettled" : "graphView.showSettled", { n: settledIds.size })}
            </button>
          )}
          {editable && (
            <button type="button" className="btn btn-ghost" data-testid="graph-update-deps" title={t("graphView.updateDepsHint")} onClick={updateDependencies}>
              <Icon name="i-sync" size={13} /> {t("graphView.updateDeps")}
            </button>
          )}
          <button type="button" className="btn btn-ghost" data-testid="graph-export" disabled={exporting || !nodes.length} onClick={() => void exportImage()}>
            <Icon name="i-download" size={13} /> {t("graphView.exportImage")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => fitGraph(250)}>
            <Icon name="i-shrink" size={13} /> {t("graphView.fit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The graph layout: issues as cards, a plugin's edges as arrows. */
export function GraphView() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
