import { useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, SelectionMode, useNodesState, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { Card } from "~/components/workspace/Card";
import { layout, NODE_W, edgeTypes } from "~/components/workspace/GraphView";
import { edgeLook, FIT, fitGraph, nodeLook, useGraphFocus, type GraphFit } from "~/components/workspace/graphLook";

/** The sheet is roomy, and a plan is read card by card: it scrolls sooner than the board's graph. */
const PLAN_FIT: GraphFit = { ...FIT, padding: 0.06, minZoom: 0.8 };
const AGENT_LINE = { stroke: "var(--accent)", dash: "6 4" };

export interface PlanLink {
  from: string;
  to: string;
  /** Solid once it counts: recorded on the tickets, or taken by the person. Dashed while it is only the agent's idea. */
  firm: boolean;
}

interface PlanNodeData extends Record<string, unknown> {
  item: Item;
  chosen: boolean;
  sub: string | null;
  /** Where the node stands in a run; absent while it is only planned. */
  state: string | undefined;
  /** It joined the run along the way, off the plan. */
  added: boolean;
  onToggle: (id: string) => void;
  onConfigure: ((id: string) => void) | undefined;
}
type PlanFlowNode = Node<PlanNodeData, "plan">;

/** The board's own card, with what a plan adds around it. */
function PlanNodeView({ data }: NodeProps<PlanFlowNode>) {
  const { item, chosen, sub, state, added, onToggle, onConfigure } = data;
  const { t } = useI18n();
  return (
    <div className={`gnode plan-node${chosen ? " is-chosen" : ""}`} style={{ width: NODE_W }} data-testid="plan-node" data-key={item.key} data-state={state} data-added={added || undefined} aria-pressed={state ? undefined : chosen} title={sub ?? undefined}>
      <Handle type="target" position={Position.Left} />
      {!state && <span className="plan-node-check" aria-hidden>{chosen && <Icon name="i-check" size={11} />}</span>}
      <Card item={item} onOpen={() => onToggle(item.id)} onNudge={() => {}} />
      {(added || sub) && (
        <span className="plan-node-sub">
          {added && <span className="plan-node-added">{t("nightShift.added")}</span>}
          {sub}
        </span>
      )}
      {onConfigure && <button
        type="button"
        className="btn btn-icon plan-node-cfg nopan"
        aria-label={t("nightShift.configure", { key: item.key })}
        title={t("nightShift.configure", { key: item.key })}
        data-testid="plan-node-cfg"
        onClick={(event) => {
          event.stopPropagation();
          onConfigure(item.id);
        }}
      >
        <Icon name="i-sliders" size={13} />
      </button>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { plan: PlanNodeView };

interface PlanGraphProps {
  items: Item[];
  links: PlanLink[];
  chosen: ReadonlySet<string>;
  subOf: (item: Item) => string | null;
  /** Changes when `subOf` would answer differently. */
  subs: string;
  onToggle: (id: string) => void;
  /** Absent in a run: the box is for choosing, and nothing is left to choose. */
  onAdd?: (ids: string[]) => void;
  onConfigure?: (id: string) => void;
  stateOf?: (id: string) => string | undefined;
  addedOf?: (id: string) => boolean;
}

function Canvas({ items, links, chosen, subOf, subs, onToggle, onAdd, onConfigure, stateOf, addedOf }: PlanGraphProps) {
  const { t } = useI18n();
  const flow = useReactFlow();
  const region = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  /** Whether the person has panned or zoomed: from then on the viewport is theirs. */
  const touched = useRef(false);
  const shape = links.map((l) => `${l.from}>${l.to}`).join();
  const ids = items.map((i) => i.id).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the shape is what moves a card, not a new array of the same tickets
  const placed = useMemo(() => layout(items, links, heights), [ids, shape, heights]);
  const shownIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const statusOf = useMemo(() => new Map(items.map((i) => [i.id, i.status])), [items]);
  const { focus, hoverSoon } = useGraphFocus(links, shownIds, null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<PlanFlowNode>([]);
  const onNodesChange = (changes: NodeChange<PlanFlowNode>[]) => {
    const measured: Record<string, number> = {};
    for (const c of changes) if (c.type === "dimensions" && c.dimensions && Math.abs((heights[c.id] ?? 0) - c.dimensions.height) > 1) measured[c.id] = c.dimensions.height;
    if (Object.keys(measured).length) setHeights((h) => ({ ...h, ...measured }));
    onNodesChangeInternal(changes);
  };
  useEffect(() => {
    // a node handed back without its measured size is hidden until it is measured again, which ends a hover
    setNodes((previous) => {
      const measured = new Map(previous.map((n) => [n.id, n.measured]));
      return items.map((item) => ({
        id: item.id,
        type: "plan" as const,
        position: placed.pos.get(item.id) ?? { x: 0, y: 0 },
        selected: false,
        measured: measured.get(item.id),
        data: { item, chosen: chosen.has(item.id), sub: subOf(item), state: stateOf?.(item.id), added: addedOf?.(item.id) ?? false, onToggle: (id: string) => toggle.current(id), onConfigure },
        ...nodeLook(focus, item.id)
      }));
    });
    // `subs` says when `subOf` changed; the function itself is new on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, placed, chosen, subs, focus, setNodes]);

  const fit = (duration?: number) => fitGraph(region.current, flow, PLAN_FIT, duration);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const settled = items.length > 0 && items.every((i) => heights[i.id] !== undefined);
  useEffect(() => {
    if (!settled || touched.current) return;
    const frame = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(frame);
  }, [settled, placed]);

  const edges = useMemo(
    (): Edge[] =>
      links.map((l) => {
        const { flow: dot, ...look } = edgeLook(l, statusOf.get(l.from), focus, l.firm ? {} : AGENT_LINE);
        return { id: `${l.from}>${l.to}`, source: l.from, target: l.to, type: "routed", selectable: false, data: { route: placed.routes.get(`${l.from}>${l.to}`), flow: dot }, ...look };
      }),
    [links, placed, statusOf, focus]
  );
  // The box only ever adds: taking a ticket off is a click on it.
  const boxed = useRef<string[]>([]);
  return (
    <div className="plan-canvas" ref={region}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        // a click on the card reaches it first, and Enter only reaches it
        onNodeClick={(event, node) => void (!(event.target as Element).closest(".card") && onToggle(node.id))}
        onNodeMouseEnter={(_, node) => hoverSoon(node.id)}
        onNodeMouseLeave={() => hoverSoon(null)}
        onMoveStart={(event) => void (event && (touched.current = true))}
        onSelectionChange={({ nodes: selected }) => { boxed.current = selected.map((n) => n.id); }}
        onSelectionEnd={() => {
          if (boxed.current.length) onAdd?.(boxed.current);
          boxed.current = [];
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        selectionOnDrag={!!onAdd}
        selectionMode={SelectionMode.Partial}
        panOnDrag={onAdd ? [1, 2] : true}
        panOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.6}
        fitView
        fitViewOptions={PLAN_FIT}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--border-soft)" />
      </ReactFlow>
      <div className="graph-foot">
        <span className="meta-txt dense graph-hint">{t(onAdd ? "nightShift.graphHintChoose" : "nightShift.graphHintWatch")}</span>
        <div className="graph-actions">
          <button type="button" className="btn btn-ghost" data-testid="plan-fit" onClick={() => fit(250)}>
            <Icon name="i-shrink" size={13} /> {t("graphView.fit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The plan on the board's graph: a click takes a ticket or leaves it, a drag across the canvas takes everything it touches. */
export function PlanGraph(props: PlanGraphProps) {
  return (
    <div className="graph-region plan-graph" data-testid="plan-graph">
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
