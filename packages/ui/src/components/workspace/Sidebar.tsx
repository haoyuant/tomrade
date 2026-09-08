import { useEffect, useRef, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import type { Board, View } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateBoard, useCreateView, useUndo, useUpdateView } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";

/** One inline name field, shared by the two "new …" rows. */
function InlineNameRow({ icon, ariaLabel, placeholder, onCommit, onCancel }: { icon: "i-board"; ariaLabel: string; placeholder: string; onCommit: (name: string) => void; onCancel: () => void }) {
  return (
    <div className="side-row is-view" style={{ cursor: "default", background: "var(--surface)", boxShadow: "var(--elev-ring)" }}>
      <Icon className="ico" name={icon} size={15} />
      <input
        autoFocus
        aria-label={ariaLabel}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: "transparent",
          padding: 0,
          color: "var(--fg)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
          outline: "none"
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter") onCommit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) onCancel();
        }}
      />
    </div>
  );
}

function ViewRow({ view, index }: { view: View; index: number }) {
  const { items, view: active, openView, virtual } = useWorkspace();
  const current = !virtual && view.id === active.id;
  const { ref, isDragging } = useSortable({ id: view.id, index, type: "view", accept: "view" });
  return (
    <button
      ref={ref as (node: HTMLElement | null) => void}
      type="button"
      className={`side-row is-view${isDragging ? " dragging" : ""}`}
      data-view={view.id}
      aria-current={current}
      title={view.name}
      // already here: switching would throw away the live draft for no reason
      onClick={() => !current && openView(view.id)}
    >
      <Icon className="ico" name={viewIcon(view.icon)} size={15} />
      <span className="side-name">{view.name}</span>
      <span className="side-count num">{viewCount(items, view)}</span>
    </button>
  );
}

/** A midpoint between neighbours, or null when there is none — then the whole roster is renumbered. */
function rankBetween(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return (next as number) - 1;
  if (next === undefined) return prev + 1;
  if (next - prev < 1e-6) return null;
  return (prev + next) / 2;
}

/**
 * The roster is sortable by drag. The order is the views' ranks, so a drop is
 * one view update (a midpoint rank) — logged and undoable like any other — or
 * a renumbering when the ranks left no room.
 */
function ViewList() {
  const { project, views } = useWorkspace();
  const update = useUpdateView(project.id);
  const [order, setOrder] = useState<View[]>(views);
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setOrder(views);
  }, [views]);

  const commit = (id: string) => {
    const list = orderRef.current;
    const at = list.findIndex((v) => v.id === id);
    if (at < 0) return;
    const rank = rankBetween(list[at - 1]?.rank, list[at + 1]?.rank);
    if (rank !== null) update.mutate({ id, patch: { rank } });
    else list.forEach((v, i) => v.rank !== i && update.mutate({ id: v.id, patch: { rank: i } }));
  };

  return (
    <DragDropProvider
      onDragStart={() => {
        dragging.current = true;
      }}
      onDragOver={(event) => setOrder((current) => move(current, event))}
      onDragEnd={(event) => {
        dragging.current = false;
        if (event.canceled) return setOrder(views);
        const id = event.operation.source?.id;
        if (id != null) commit(String(id));
      }}
    >
      <div className="side-list" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {order.map((v, i) => (
          <ViewRow key={v.id} view={v} index={i} />
        ))}
      </div>
    </DragDropProvider>
  );
}

/** Creating a view is a real write: it lands in the roster, opens, and stays undoable. */
function NewViewRow() {
  const { t, tx } = useI18n();
  const { project, openView } = useWorkspace();
  const create = useCreateView(project.id);
  const undo = useUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add side-new-view" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">{t("sidebar.newView")}</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    create.mutate(
      { name: trimmed, icon: "i-board", layout: "board", query: { columnBy: "status" } },
      {
        onSuccess: (view) => {
          setEditing(false);
          openView(view.id);
          toast({
            body: <>{tx("sidebar.createdViewToast", { name: <span className="num">{trimmed}</span> })}</>,
            onUndo: () => undo.mutate(view.id)
          });
        },
        onError: (err) => toast({ body: err.message })
      }
    );
  };

  return <InlineNameRow icon="i-board" ariaLabel={t("sidebar.newViewNameAria")} placeholder={t("sidebar.viewNamePlaceholder")} onCommit={commit} onCancel={() => setEditing(false)} />;
}

/**
 * A workstream row is a place: its page shows everything in the workstream as
 * a board by status, unsaved, and reads as current instead of any view.
 */
function WorkstreamRow({ board }: { board: Board }) {
  const { t } = useI18n();
  const { owned, openWorkstream, virtual, workstream } = useWorkspace();
  const current = virtual && workstream?.id === board.id;
  const count = owned.filter((i) => i.boardId === board.id).length;
  return (
    <button
      type="button"
      className="side-row is-workstream"
      data-board={board.id}
      aria-current={current}
      title={t("sidebar.openWorkstreamTitle", { name: board.name })}
      onClick={() => !current && openWorkstream(board.id)}
    >
      <Icon className="ico" name={viewIcon(board.icon)} size={15} />
      <span className="side-name">{board.name}</span>
      <span className="side-count num">{count}</span>
    </button>
  );
}

/** Creating a workstream is a real write: it becomes an option of the Workstream field at once, and stays undoable. */
function NewWorkstreamRow() {
  const { t, tx } = useI18n();
  const { project } = useWorkspace();
  const create = useCreateBoard(project.id);
  const undo = useUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add side-new-workstream" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">{t("sidebar.newWorkstream")}</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    create.mutate(
      { name: trimmed, icon: "i-board" },
      {
        onSuccess: (board) => {
          setEditing(false);
          toast({ body: <>{tx("sidebar.createdWorkstreamToast", { name: <span className="num">{trimmed}</span> })}</>, onUndo: () => undo.mutate(board.id) });
        },
        onError: (err) => toast({ body: err.message })
      }
    );
  };

  return <InlineNameRow icon="i-board" ariaLabel={t("sidebar.newWorkstreamNameAria")} placeholder={t("sidebar.workstreamNamePlaceholder")} onCommit={commit} onCancel={() => setEditing(false)} />;
}

/**
 * The project's saved views, its workstreams, and the door to its fields.
 * Leaving the project is chrome work — home and the switcher, both in the
 * titlebar. Collapsed, it is the same rail the assistant folds to, and the view
 * head grows its own switcher.
 */
export function Sidebar({
  open,
  onToggle,
  onOpenFields,
  onOpenProjectSettings
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenFields: (fieldId?: string) => void;
  onOpenProjectSettings: () => void;
}) {
  const { t } = useI18n();
  const { boards } = useWorkspace();

  if (!open) {
    return (
      <div className="rail side-rail">
        <button type="button" className="btn btn-icon" title={t("sidebar.expandSidebar")} aria-label={t("sidebar.expandSidebar")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
        </button>
        <span className="rail-label">{t("sidebar.viewsRailLabel")}</span>
      </div>
    );
  }

  return (
    <nav className="sidebar">
      <div className="side-head">
        <Eyebrow>{t("sidebar.viewsEyebrow")}</Eyebrow>
        <Spacer />
        <button type="button" className="btn btn-icon" title={t("sidebar.collapseSidebar")} aria-label={t("sidebar.collapseSidebar")} onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
        </button>
      </div>
      <div className="side-group">
        <ViewList />
        <NewViewRow />
      </div>
      <div className="side-group side-workstreams">
        <div className="side-label-row">
          <Eyebrow className="side-label">{t("sidebar.workstreamsEyebrow")}</Eyebrow>
          <Spacer />
          <button type="button" className="btn btn-icon side-ws-manage" aria-haspopup="dialog" title={t("sidebar.manageWorkstreams")} aria-label={t("sidebar.manageWorkstreams")} onClick={() => onOpenFields("board")}>
            <Icon name="i-sliders" size={13} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {boards.map((b) => (
            <WorkstreamRow key={b.id} board={b} />
          ))}
        </div>
        <NewWorkstreamRow />
      </div>
      <div className="side-group side-foot">
        <button type="button" className="side-row side-add side-fields" aria-haspopup="dialog" onClick={() => onOpenFields()}>
          <Icon className="ico" name="i-sliders" size={14} />
          <span className="side-name">{t("sidebar.fields")}</span>
        </button>
        <button type="button" className="side-row side-add side-project-settings" aria-haspopup="dialog" onClick={onOpenProjectSettings}>
          <Icon className="ico" name="i-gear" size={14} />
          <span className="side-name">{t("sidebar.projectSettings")}</span>
        </button>
      </div>
    </nav>
  );
}

export const sidebarOpenKey = "tomrade.sidebar.open";
