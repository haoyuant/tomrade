import { useState } from "react";
import type { Board, FilterClause, View } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateBoard, useCreateView, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";

/** The one workstream a filter pins, or null when it pins none or several. */
function pinnedBoard(filter: FilterClause[]): string | null {
  const clauses = filter.filter((c) => c.field === "board" && c.op === "in");
  if (clauses.length !== 1 || clauses[0].values.length !== 1) return null;
  const only = clauses[0].values[0];
  return typeof only === "string" ? only : null;
}

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

function ViewRow({ view }: { view: View }) {
  const { items, view: active, openView } = useWorkspace();
  const current = view.id === active.id;
  return (
    <button
      type="button"
      className="side-row is-view"
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
 * A workstream row is a quick slice: it pins the live draft to that workstream
 * and reads as current while it does. The count is the whole workstream,
 * whatever the view shows.
 */
function WorkstreamRow({ board }: { board: Board }) {
  const { t } = useI18n();
  const { owned, query, setQuery } = useWorkspace();
  const pinned = pinnedBoard(query.filter) === board.id;
  const count = owned.filter((i) => i.boardId === board.id).length;
  const toggle = () => {
    const rest = query.filter.filter((c) => c.field !== "board");
    setQuery({ ...query, filter: pinned ? rest : [{ field: "board", op: "in", values: [board.id] }, ...rest] });
  };
  return (
    <button
      type="button"
      className="side-row is-workstream"
      data-board={board.id}
      aria-pressed={pinned}
      aria-current={pinned}
      title={pinned ? t("sidebar.workstreamUnfilterTitle", { name: board.name }) : t("sidebar.workstreamFilterTitle", { name: board.name })}
      onClick={toggle}
    >
      <Icon className="ico" name={viewIcon(board.icon)} size={15} />
      <span className="side-stack">
        <span className="side-name">{board.name}</span>
        {board.subtitle && <span className="side-pkg">{board.subtitle}</span>}
      </span>
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
export function Sidebar({ open, onToggle, onOpenFields }: { open: boolean; onToggle: (open: boolean) => void; onOpenFields: (fieldId?: string) => void }) {
  const { t } = useI18n();
  const { views, boards } = useWorkspace();

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
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {views.map((v) => (
            <ViewRow key={v.id} view={v} />
          ))}
        </div>
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
          <Icon className="ico" name="i-gear" size={14} />
          <span className="side-name">{t("sidebar.fields")}</span>
        </button>
      </div>
    </nav>
  );
}

export const sidebarOpenKey = "tomrade.sidebar.open";
