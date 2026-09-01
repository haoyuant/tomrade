import { useEffect, useMemo } from "react";
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
  type NodeProps
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { Item } from "@tomrade/domain";
import type { GraphEdge } from "@tomrade/contributions";
import { Icon } from "~/components/icons";
import { useIssueWriter } from "~/components/issue/fields";
import { matchesQuery } from "~/lib/domain";
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

const EDGE_STROKE: Record<string, string> = {
  faint: "var(--rule)",
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
  const graph = (graphs.data ?? []).find((g) => g.id === ws.query.graph);
  const serverEdges = useGraphEdges(ws.project.id, ws.query.graph);
  const editable = graph?.edits === "blocks";

  // The facets still slice the board; only the column picker has no say here.
  const shown = useMemo(() => ws.owned.filter((i) => matchesQuery(i, ws.query)), [ws.owned, ws.query]);
  const shownIds = useMemo(() => new Set(shown.map((i) => i.id)), [shown]);
  const edges = useMemo(() => (serverEdges.data ?? []).filter((e) => shownIds.has(e.from) && shownIds.has(e.to)), [serverEdges.data, shownIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState<IssueNode>([]);

  // Re-derive nodes from the live items; a position someone dragged survives
  // the refetch, only new nodes take the computed one.
  const edgeShape = edges.map((e) => `${e.from}>${e.to}`).join();
  useEffect(() => {
    const placed = layout(shown, edges);
    setNodes((current) => {
      const kept = new Map(current.map((n) => [n.id, n.position]));
      return shown.map((item) => ({
        id: item.id,
        type: "issue" as const,
        position: kept.get(item.id) ?? placed.get(item.id) ?? { x: 0, y: 0 },
        data: { item },
        deletable: false,
        connectable: editable,
        selected: item.id === ws.selectedId
      }));
    });
  }, [shown, edgeShape, editable, ws.selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: `${e.from}>${e.to}`,
        source: e.from,
        target: e.to,
        title: e.title,
        selectable: editable,
        deletable: editable,
        style: { stroke: EDGE_STROKE[e.tone ?? "neutral"], strokeWidth: e.tone === "danger" ? 2 : 1.5 },
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
    write(
      source,
      { blocks: [...source.blocks, target.id] },
      t("graphView.linkedToast", { from: source.key, to: target.key })
    );
  };

  const onEdgesDelete = (deleted: Edge[]) => {
    for (const edge of deleted) {
      const source = findItem(edge.source);
      const target = findItem(edge.target);
      if (!source || !target || !source.blocks.includes(target.id)) continue;
      write(
        source,
        { blocks: source.blocks.filter((id) => id !== target.id) },
        t("graphView.unlinkedToast", { from: source.key, to: target.key })
      );
    }
  };

  return (
    <div className="graph-region" data-graph={ws.query.graph ?? undefined}>
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
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--rule)" />
      </ReactFlow>
      {shown.length === 0 && <p className="col-empty graph-empty">{t("graphView.empty")}</p>}
      <div className="graph-foot">
        <span className="meta-txt dense">{editable ? t("graphView.editHint") : t("graphView.readOnlyHint")}</span>
        <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={() => void fitView({ padding: 0.15, maxZoom: 1, duration: 250 })}>
          <Icon name="i-shrink" size={13} /> {t("graphView.fit")}
        </button>
      </div>
    </div>
  );
}

/** The board region in graph mode: issues as cards, dependencies as arrows. */
export function GraphView() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
