import { useState } from "react";
import type { View } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateView, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";

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

  return (
    <div className="side-row is-view" style={{ cursor: "default", background: "var(--surface)", boxShadow: "var(--elev-ring)" }}>
      <Icon className="ico" name="i-board" size={15} />
      <input
        autoFocus
        aria-label={t("sidebar.newViewNameAria")}
        placeholder={t("sidebar.viewNamePlaceholder")}
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
            setEditing(false);
          }
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setEditing(false);
        }}
      />
    </div>
  );
}

/**
 * The project's saved views, and nothing else. Leaving the project is chrome
 * work — home and the switcher, both in the titlebar. Collapsed, it is the same
 * rail the assistant folds to, and the view head grows its own switcher.
 */
export function Sidebar({ open, onToggle, onOpenFields }: { open: boolean; onToggle: (open: boolean) => void; onOpenFields: () => void }) {
  const { t } = useI18n();
  const { views } = useWorkspace();

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
      <div className="side-group side-foot">
        <button type="button" className="side-row side-add side-fields" aria-haspopup="dialog" onClick={onOpenFields}>
          <Icon className="ico" name="i-gear" size={14} />
          <span className="side-name">{t("sidebar.fields")}</span>
        </button>
      </div>
    </nav>
  );
}

export const sidebarOpenKey = "tomrade.sidebar.open";
