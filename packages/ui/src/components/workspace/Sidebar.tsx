import { useState } from "react";
import type { Board } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { boardSubtitle } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateBoard, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { boardCount, useWorkspace } from "./context";

function BoardRow({ board }: { board: Board }) {
  const { items, board: active, openSpace } = useWorkspace();
  const count = boardCount(items, board);
  const current = board.id === active.id;
  return (
    <button
      type="button"
      className="side-row is-board"
      aria-current={current}
      title={board.note ?? boardSubtitle(board)}
      // already here: switching would throw away the live query for no reason
      onClick={() => !current && openSpace(board.id)}
    >
      <Icon className="ico" name={board.icon as IconId} size={15} />
      <span className="side-stack">
        <span className="side-name">{board.name}</span>
        <span className="side-pkg">{boardSubtitle(board)}</span>
      </span>
      <span className="side-count num">{count}</span>
    </button>
  );
}

/**
 * Creating a board is a real write: it makes the workstream and its four
 * built-in views, switches to it, and stays undoable.
 */
function NewBoardRow() {
  const { t, tx } = useI18n();
  const { project, openSpace } = useWorkspace();
  const create = useCreateBoard(project.id);
  const undo = useUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">{t("sidebar.newBoard")}</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "board";
    create.mutate(
      { name: trimmed, icon: "i-board", subtitle: `packages/${slug}` },
      {
        onSuccess: (board) => {
          setEditing(false);
          openSpace(board.id, board.defaultViewId);
          toast({
            body: <>{tx("sidebar.createdBoardToast", { name: <span className="num">{trimmed}</span> })}</>,
            onUndo: () => undo.mutate(board.id)
          });
        }
      }
    );
  };

  return (
    <div className="side-row is-board" style={{ cursor: "default", background: "var(--surface)", boxShadow: "var(--elev-ring)" }}>
      <Icon className="ico" name="i-board" size={15} />
      <input
        autoFocus
        aria-label={t("sidebar.newBoardNameAria")}
        placeholder={t("sidebar.workstreamPlaceholder")}
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
 * Boards inside THIS project, and nothing else. Leaving the project is chrome
 * work — home and the switcher, both in the titlebar. Collapsed, it is the same
 * rail the assistant folds to, and the board head grows its own switcher.
 */
export function Sidebar({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  const { t } = useI18n();
  const { boards } = useWorkspace();
  const workstreams = boards.filter((b) => !b.across);
  const scopes = boards.filter((b) => b.across);

  if (!open) {
    return (
      <div className="rail side-rail">
        <button type="button" className="btn btn-icon" title={t("sidebar.expandSidebar")} aria-label={t("sidebar.expandSidebar")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
        </button>
        <span className="rail-label">{t("sidebar.boardsRailLabel")}</span>
      </div>
    );
  }

  return (
    <nav className="sidebar">
      <div className="side-head">
        <Eyebrow>{t("sidebar.boardsEyebrow")}</Eyebrow>
        <Spacer />
        <button type="button" className="btn btn-icon" title={t("sidebar.collapseSidebar")} aria-label={t("sidebar.collapseSidebar")} onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
        </button>
      </div>
      <div className="side-group">
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {workstreams.map((b) => (
            <BoardRow key={b.id} board={b} />
          ))}
        </div>
        <NewBoardRow />
      </div>
      {scopes.length > 0 && (
        <div className="side-group">
          <Eyebrow className="side-label">{t("sidebar.acrossBoards")}</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {scopes.map((b) => (
              <BoardRow key={b.id} board={b} />
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

export const sidebarOpenKey = "tomrade.sidebar.open";
