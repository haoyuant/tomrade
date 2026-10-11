import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { Item } from "@tomradex/domain";
import type { GraphEdge } from "@tomradex/contributions";
import { Icon } from "~/components/icons";
import { useIssueWriter } from "~/components/issue/fields";
import { useI18n } from "~/lib/i18n";
import { useGraphEdges, useGraphs } from "~/lib/queries";
import { Card } from "./Card";
import { useWorkspace } from "./context";

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

/** Blocker → blocked reads left to right; disconnected issues gather below. */
function layout(items: Item[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 80, acyclicer: "greedy" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const item of items) g.setNode(item.id, { width: NODE_W, height: NODE_H });
  for (const edge of edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    const pos = g.node(item.id);
    out.set(item.id, { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }
  return out;
}

/** Below this a card's title is too small to read. */
const FIT_MIN_ZOOM = 0.65;

// a satisfied dependency reads quieter, and dashed, rather than vanishing
const EDGE_STROKE: Record<string, string> = {
  faint: "var(--border)",
  neutral: "var(--meta)",
  strong: "var(--meta)",
  danger: "var(--danger)"
};

function Canvas() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const { write } = useIssueWriter(ws.project.id);
  const { fitView } = useReactFlow();
  const graphs = useGraphs();
  // The view names its edge source; a view saved before any plugin contributed one falls back to the first.
  const graphId = ws.query.graph ?? graphs.data?.[0]?.id ?? null;
  const graph = (graphs.data ?? []).find((g) => g.id === graphId);
  const serverEdges = useGraphEdges(ws.project.id, graphId);
  const editable = graph?.edits === "blocks";

  // The filter decides which issues are nodes; the sort is irrelevant on a canvas.
  const shown = ws.visible;
  const shownIds = useMemo(() => new Set(shown.map((i) => i.id)), [shown]);
  const edges = useMemo(() => (serverEdges.data ?? []).filter((e) => shownIds.has(e.from) && shownIds.has(e.to)), [serverEdges.data, shownIds]);

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<IssueNode>([]);

  // Only a completed drag earns a sticky position; everything else is
  // re-laid-out on every data change so a stale pre-edges-loaded layout
  // (dagre with no edges yet — see `layout`) never survives once the real
  // edges arrive.
  const dragged = useRef(new Map<string, { x: number; y: number }>());
  const onNodesChange = (changes: NodeChange<IssueNode>[]) => {
    for (const c of changes) if (c.type === "position" && c.position && c.dragging === false) dragged.current.set(c.id, c.position);
    onNodesChangeInternal(changes);
  };

  const edgeShape = edges.map((e) => `${e.from}>${e.to}`).join();
  // dagre runs when the nodes or the edges change, not when a card is selected
  const placed = useMemo(() => layout(shown, edges), [shown, edgeShape]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setNodes(
      shown.map((item) => ({
        id: item.id,
        type: "issue" as const,
        position: dragged.current.get(item.id) ?? placed.get(item.id) ?? { x: 0, y: 0 },
        data: { item },
        deletable: false,
        connectable: editable,
        selected: item.id === ws.selectedId
      }))
    );
  }, [shown, placed, editable, ws.selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: `${e.from}>${e.to}`,
        source: e.from,
        target: e.to,
        title: e.title,
        selectable: editable,
        deletable: editable,
        style: { stroke: EDGE_STROKE[e.tone ?? "neutral"], strokeWidth: e.tone === "danger" ? 2 : 1.5, ...(e.tone === "faint" ? { strokeDasharray: "4 3" } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_STROKE[e.tone ?? "neutral"] }
      })),
    [edges, editable]
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

  return (
    <div className="graph-region" data-graph={graphId ?? undefined}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        fitView
        // fitting a wide graph never shrinks the cards past reading; the rest is a pan away
        fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--border-soft)" />
      </ReactFlow>
      {shown.length === 0 && <p className="col-empty graph-empty">{t("graphView.empty")}</p>}
      {!graphId && <p className="col-empty graph-empty">{t("graphView.noGraph")}</p>}
      <div className="graph-foot">
        <span className="meta-txt dense">{editable ? t("graphView.editHint") : t("graphView.readOnlyHint")}</span>
        <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={() => void fitView({ padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM, duration: 250 })}>
          <Icon name="i-shrink" size={13} /> {t("graphView.fit")}
        </button>
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
