import { useEffect, useMemo, useRef } from "react";
import { Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, SelectionMode, useNodesState, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { layout, NODE_W, edgeTypes } from "~/components/workspace/GraphView";

/** Tall enough for a key, two lines of title and a line of why. */
const PLAN_NODE_H = 84;
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.45 };

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
  onConfigure: ((id: string) => void) | undefined;
}
type PlanFlowNode = Node<PlanNodeData, "plan">;

function PlanNodeView({ data }: NodeProps<PlanFlowNode>) {
  const { item, chosen, sub, state, added, onConfigure } = data;
  const { t } = useI18n();
  return (
    <div className={`plan-node${chosen ? " is-chosen" : ""}`} style={{ width: NODE_W, height: PLAN_NODE_H }} data-testid="plan-node" data-key={item.key} data-state={state} data-added={added || undefined} aria-pressed={state ? undefined : chosen} title={sub ?? item.title}>
      <Handle type="target" position={Position.Left} />
      {!state && <span className="plan-node-check" aria-hidden>{chosen && <Icon name="i-check" size={11} />}</span>}
      <span className="plan-node-text">
        <span className="plan-node-title">{added && <span className="plan-node-added">{t("nightShift.added")}</span>} <span className="num">{item.key}</span> {item.title}</span>
        {sub && <span className="plan-node-sub">{sub}</span>}
      </span>
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
  const { fitView } = useReactFlow();
  const shape = links.map((l) => `${l.from}>${l.to}`).join();
  const ids = items.map((i) => i.id).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the shape is what moves a card, not a new array of the same tickets
  const placed = useMemo(() => layout(items, links, Object.fromEntries(items.map((i) => [i.id, PLAN_NODE_H]))), [ids, shape]);
  const [nodes, setNodes, onNodesChange] = useNodesState<PlanFlowNode>([]);
  useEffect(() => {
    setNodes(items.map((item) => ({ id: item.id, type: "plan", position: placed.pos.get(item.id) ?? { x: 0, y: 0 }, selected: false, data: { item, chosen: chosen.has(item.id), sub: subOf(item), state: stateOf?.(item.id), added: addedOf?.(item.id) ?? false, onConfigure } })));
    // `subs` says when `subOf` changed; the function itself is new on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, placed, chosen, subs, setNodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView(FIT));
    return () => cancelAnimationFrame(frame);
  }, [ids, shape, fitView]);
  const edges = useMemo(
    (): Edge[] =>
      links.map((l) => ({
        id: `${l.from}>${l.to}`,
        source: l.from,
        target: l.to,
        type: "routed",
        selectable: false,
        data: { route: placed.routes.get(`${l.from}>${l.to}`) },
        style: l.firm ? { stroke: "var(--meta)" } : { stroke: "var(--accent)", strokeDasharray: "6 4" }
      })),
    [links, placed]
  );
  // The box only ever adds: taking a ticket off is a click on it.
  const boxed = useRef<string[]>([]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onToggle(node.id)}
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
      minZoom={0.3}
      fitView
      fitViewOptions={FIT}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
    </ReactFlow>
  );
}

/** The plan as a graph: a click takes a ticket or leaves it, a drag across the canvas takes everything it touches. */
export function PlanGraph(props: PlanGraphProps) {
  return (
    <div className="plan-graph" data-testid="plan-graph">
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
